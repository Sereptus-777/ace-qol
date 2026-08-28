// ─── ACE QOL — Boot report ────────────────────────────────────────────────────
//
// One card, at load, telling the GM whether ACE came up clean.
//
// ⚠️ WHY THIS EXISTS. Johnny, 2026-08-13, and he was right:
//
//   "I am never searching the console for anything... There's like a billion
//    lines that come through there... You say 'just reload and look at the
//    console, if it has this in one of those billion lines then we'll know'.
//    Pretty pathetic when you think about it."
//
// It is. ACE had grown three separate startup checks — the condition-ghost
// sweep, the platform API contract, and the expired spell-space cleanup — and
// every one of them reported into a console nobody reads. A check whose result
// is never seen is not a check. Worse, on 2026-08-12 the platform contract
// turned out to have never run at all AT LOAD, and its silence read exactly like
// a pass. The only reason that surfaced was a timestamp Johnny happened to spot.
//
// So: the answer comes to HIM, in the chat log, in one card, in plain English.
//
// ⚠️ QUIET WHEN CLEAN, LOUD WHEN NOT — AND IT MEANS IT NOW. This said exactly
// that from the day it was written while posting a green card at every load,
// which is how a status report becomes furniture. Nothing reaches chat unless
// something is actually wrong.
// If something is actually wrong it says what, in words that name the FEATURE
// rather than the function — "saves and overtime effects", not "rollSavingThrow".
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ Local, not imported from ace-qol.mjs — that cycle is the temporal-dead-zone
// crash that made every token unclickable on 2026-08-11.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | BootReport";

/** Let the other startup jobs finish before we report on them. */
const SETTLE_MS = 2500;

export class BootReport {

  static async gather() {
    const out = { ghosts: null, contract: null, versions: {}, problems: [] };

    // Module versions — so a screenshot of this card is enough to know what he
    // was running, without asking.
    for (const id of ["ace-qol", "ace-artificer", "ace-engine"]) {
      try {
        const m = game.modules.get(id);
        if (m?.active) out.versions[id] = m.version;
      } catch (_) { /* not installed */ }
    }

    // Condition ghosts still on the world AFTER the sweeper has run.
    try {
      const { ConditionGhostSweeper } = await import("./condition-ghost-sweeper.mjs");
      out.ghosts = ConditionGhostSweeper.find().length;
      if (out.ghosts > 0) {
        out.problems.push(`${out.ghosts} dead condition record${out.ghosts === 1 ? "" : "s"} are still blocking those conditions from ever being applied — something is disabling conditions instead of deleting them.`);
      }
    } catch (err) {
      out.problems.push("The condition-ghost check could not run — conditions may be silently un-appliable.");
      console.warn(`${LOG} | ghost check failed:`, err);
    }

    // Platform APIs ACE depends on.
    try {
      const { checkContract } = await import("./platform-contract.mjs");
      const { missing, checked } = checkContract();
      out.contract = { missing: missing.length, checked };
      for (const m of missing) {
        out.problems.push(`The game system no longer provides <em>${m.on}.${m.name}</em> — that breaks: ${m.used}.`);
      }
    } catch (err) {
      out.problems.push("The platform check could not run — a renamed game-system function would go unnoticed.");
      console.warn(`${LOG} | contract check failed:`, err);
    }

    return out;
  }

  static async post() {
    const r = await BootReport.gather();
    const clean = r.problems.length === 0;
    const vers = Object.entries(r.versions).map(([k, v]) => `${k.replace("ace-", "")} ${v}`).join(" · ");

    // ⚠️🔴 NOTHING IS POSTED WHEN THERE IS NOTHING TO SAY. Johnny, 2026-08-28:
    // "I'm really getting tired of this pop-up in the chat saying that
    // everything's working fine, right on. Good. Get rid of that."
    //
    // He is right, and this file's own header has claimed "QUIET WHEN CLEAN,
    // LOUD WHEN NOT" since the day it was written while posting a green card at
    // every single load. A card that appears every time carries no information:
    // it becomes furniture, and the one load where it turns red is the one
    // nobody looks at.
    //
    // ⚠️ THE FAILURE PATH IS UNCHANGED AND MUST STAY THAT WAY. He asked for
    // this card in the first place on 2026-08-13, because the checks it reports
    // were shouting into a console nobody reads and one of them had never run at
    // all. Silence when clean is the point; silence when broken is the bug.
    if (clean) {
      console.log(`${LOG} | clean — no dead condition records`
        + `${r.contract ? `, all ${r.contract.checked} game-system functions present` : ""}`
        + `. Nothing posted to chat; there is nothing to report.`);
      return;
    }

    const head = "ACE started — needs your attention";
    const colour = "#d46a6a";
    const body = `<ul style="color:#f0e4c0;font-size:16px;line-height:1.55;margin:6px 0 0;padding-left:20px;">
           ${r.problems.map(p => `<li style="margin-bottom:5px;">${p}</li>`).join("")}
         </ul>`;

    await ChatMessage.create({
      whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
      content: `<div style="background:#141519;border-left:4px solid ${colour};border-radius:6px;padding:12px 14px;">
          <div style="color:${colour};font-size:18px;font-weight:700;letter-spacing:.03em;">${head}</div>
          ${body}
          <div style="color:#6f6a5c;font-size:13px;margin-top:10px;">${vers}</div>
        </div>`,
      flags: { [MODULE_ID]: { type: "bootReport" } },
    }).catch(err => console.warn(`${LOG} | could not post the boot report:`, err));

    console.log(`${LOG} | ${r.problems.length} problem(s) — reported to the GM in chat.`);
  }

  static register() {
    const run = () => {
      // ⚠️ ACTIVE GM ONLY — otherwise every connected GM login posts a copy.
      if (game.users?.activeGM !== game.user) return;
      // ⚠️ WAIT FOR THE OTHERS. The ghost sweeper and the region cleanup are
      // async and start at the same moment we do; reporting immediately would
      // count ghosts that are mid-deletion and cry wolf on the GM's own screen.
      setTimeout(() => { BootReport.post().catch(() => {}); }, SETTLE_MS);
    };

    // ⚠️ `register()` runs from INSIDE ace-qol's ready handler, so a bare
    // Hooks.once("ready") here would wait on an event that already fired and
    // never run — the trap that silently disabled four features on 2026-08-12.
    if (game.ready) run();
    else Hooks.once("ready", run);

    console.log(`${LOG} | online`);
  }
}
