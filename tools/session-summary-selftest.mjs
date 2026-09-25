// ═══════════════════════════════════════════════════════════════════════════
//  SESSION SUMMARY SELF-TEST — the record of his night is never cut
// ───────────────────────────────────────────────────────────────────────────
//  2026-09-24. ACE posted "Session 15 Summary saved to journal… This confro…"
//  and he read it, reasonably, as the most important thing the module does
//  quietly losing his session: "This is the most fucking important part of the
//  whole fucking module in Ace Engine: to save what happened."
//
//  What was actually cut was the NOTE, at 300 characters, with an ellipsis
//  stuck on the end. The journal and the store had the whole thing. That
//  distinction is invisible from the outside, which is why the note may never
//  do it again, and why this test exists.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";

const ENGINE = "D:/FoundryVTT/Data/modules/ace-engine/scripts";
const panel = readFileSync(`${ENGINE}/panel.mjs`, "utf8");
const memory = readFileSync(`${ENGINE}/memory-manager.mjs`, "utf8");
const limits = readFileSync(`${ENGINE}/text-limits.mjs`, "utf8");

let passed = 0, failed = 0;
const check = (what, ok, detail = "") => {
    if (ok) { passed++; console.log(`  ok   ${what}`); }
    else { failed++; console.log(`  FAIL ${what}${detail ? `  ${detail}` : ""}`); }
};

console.log("\nSESSION SUMMARY: THE RECORD OF HIS NIGHT IS NEVER CUT");

// ── 1. The note posts the summary whole ──────────────────────────────────
{
    const endSession = panel.slice(panel.indexOf("async _runEndSession()"),
                                   panel.indexOf("Session summary FAILED"));
    check("the summary note carries the whole summary, with no slice and no ellipsis",
        endSession.includes("**Session ${sessionNum} Summary**\\n\\n${summary}")
          && !/summary\.slice\(0,\s*\d+\)/.test(endSession)
          && !endSession.includes('summary.length > 300'),
        "the 300-character cut is gone");

    check("and it names the journal it was saved to, and how long it is",
        endSession.includes("Saved in full to the journal")
          && endSession.includes("${summary.length} characters"),
        "a save he can verify without opening anything");
}

// ── 2. Nothing else in the path shortens it ──────────────────────────────
{
    const save = memory.slice(memory.indexOf("async saveSessionSummary("),
                              memory.indexOf("getNextSessionNum()"));
    check("the stored record keeps the summary at the runaway ceiling, not a real limit",
        save.includes("trimToSentence(summary, STORE_LIMIT.sessionSummary)")
          && limits.includes("const RUNAWAY_GUARD = 100_000;")
          && limits.includes("sessionSummary: RUNAWAY_GUARD"),
        "100,000 characters is a guard against a stuck loop, not a summary length");

    const journal = memory.slice(memory.indexOf("async _writeSessionJournal(record)"),
                                 memory.indexOf("// ── Bulk Journal Sync"));
    check("and the journal page is written from that same record, whole",
        journal.includes("${record.summary.replace(/\\n/g, \"<br>\")}")
          && !/record\.summary\.slice\(/.test(journal),
        "what the store holds is what the journal shows");
}

// ── 3. How much of the session the model was shown ───────────────────────
{
    check("the digest carries five hundred events rather than a hundred and fifty",
        memory.includes("const digest     = this.getEventDigest(500);"),
        "a long night no longer arrives as its own tail");

    check("and it records how much it carried, so a capped summary can say so",
        memory.includes("this.lastDigestSpan = { used: events.length, total: all.length, capped: all.length > events.length };")
          && panel.includes("the earlier ones did not fit"),
        "silence about a partial summary is the thing that cost him trust");
}

// ── 4. trimToSentence, run for real ──────────────────────────────────────
{
    const code = limits.replace(/^export /gm, "");
    const { trimToSentence } = new Function(code + "\nreturn { trimToSentence };")();

    const long = ("The party crossed the bridge at dusk and the wind rose behind them. " .repeat(60)).trim();
    check("a five-thousand character summary is returned untouched",
        trimToSentence(long, 100_000) === long, `${long.length} chars in`);

    const cut = trimToSentence(long, 200);
    check("and when something genuinely exceeds the ceiling it stops on a sentence, not mid-word",
        cut.length <= 200 && /[.!?]$/.test(cut.trim()), `ended: ${JSON.stringify(cut.slice(-40))}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
