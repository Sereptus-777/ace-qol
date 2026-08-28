// ─── What did ACE work out, and is it right? ────────────────────────────────
//
// ⚠️ AN ENGINE YOU CANNOT ARGUE WITH IS AN ENGINE YOU CANNOT TRUST. The
// classifier agrees with the hand-written entries 75 times in 101 measured
// against Johnny's own world. That is good enough to fill 1,400 gaps and
// nowhere near good enough to be beyond question, so every reading it makes is
// listed here with the evidence that produced it and a way to overrule it.
//
// ⚠️ A CORRECTION IS PERMANENT. LearnedStore.correct writes a flag the
// classifier is never allowed to overwrite, including after an item is edited
// and after this engine is rewritten. An engine that quietly re-guesses over a
// correction teaches you to stop correcting it.
//
// ⚠️ GM ONLY, AND READ-ONLY UNTIL HE TOUCHES IT. Nothing here changes anything
// by being opened.
// ⚠️ MODULE_ID IS HARDCODED, MATCHING THE CONVENTION ALREADY IN THIS
// CODEBASE. ace-qol.mjs imports this file, so importing MODULE_ID back out of
// it is a cycle: ES modules evaluate the imported file's body FIRST, and the
// const is still in its temporal dead zone. concentration-widget.mjs,
// blade-cantrips.mjs, death-pipeline.mjs and diagnostics.mjs all do exactly
// this, one of them with the comment "hardcoded to avoid circular import".
// The first version of this file imported it and threw at load, which in
// Foundry is the entry file failing and the whole module going dark.
const MODULE_ID = "ace-qol";
import { LearnedStore } from "./learned-store.mjs";
import { classifyItem, KNOWN_SHAPES, describeClassification } from "./classify-item.mjs";
import { DescriptionParser } from "../description-parser.mjs";
import { getSpellTiming } from "../spell-timing.mjs";

/** Read one item the way the pipeline would, without changing anything. */
export function explain(item) {
  const parsed = (() => { try { return DescriptionParser.parse(item); } catch (_) { return null; } })();
  const timing = (() => { try { return getSpellTiming(item); } catch (_) { return null; } })();
  const result = classifyItem(item, { parsed, timing });
  const learned = LearnedStore.get(item, result.facts);
  return { item, result, learned, line: describeClassification(result, item?.name) };
}

/**
 * Everything ACE has worked out about the items on one actor, or on every
 * player character when no actor is given.
 */
export function reviewActor(actor = null) {
  const actors = actor ? [actor]
    : (game.actors ?? []).filter(a => a?.type === "character" && a.hasPlayerOwner);
  const rows = [];
  for (const a of actors) {
    for (const item of (a.items ?? [])) {
      if (item.type !== "spell" && item.type !== "feat" && item.type !== "weapon") continue;
      // Curated entries are not ACE's opinion, they are somebody's ruling, and
      // listing them here would drown the readings that actually need eyes.
      const curated = game.aceQol?.SpellPipeline?._getEntry?.(item);
      if (curated && !curated.inferred) continue;
      const e = explain(item);
      if (!e.result.shape && !e.result.passive) continue;
      rows.push({ actor: a.name, item, ...e });
    }
  }
  return rows;
}

/** A chat card listing what ACE worked out, with the evidence for each. */
export async function postReviewCard(actor = null) {
  if (!game.user?.isGM) return;
  const rows = reviewActor(actor);
  const esc = (t) => foundry.utils.escapeHTML(String(t ?? ""));

  if (!rows.length) {
    ui.notifications?.info(`ACE has not had to work anything out for `
      + `${actor?.name ?? "your players"} — every item is either curated or passive.`);
    return;
  }

  const body = rows.slice(0, 40).map(r => {
    const corrected = r.learned?.correctedByHuman;
    const tone = corrected ? "#7fd18b" : r.result.confidence === "high" ? "#d4af37" : "#c78d3d";
    return `
      <div style="border-left:3px solid ${tone};padding:6px 10px;margin-bottom:8px;background:rgba(212,175,55,0.06);">
        <div style="font-size:14px;color:#f0e4c0;">
          <strong>${esc(r.item.name)}</strong>
          <span style="color:#9aa4ad;font-size:12px;"> ${esc(r.actor)}</span>
          <span style="float:right;color:${tone};font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">
            ${esc(corrected ? "you corrected this" : (r.result.shape ?? "passive"))}
          </span>
        </div>
        <div style="font-size:12px;color:#c0b288;line-height:1.5;margin-top:3px;">
          ${esc((r.result.evidence ?? []).slice(0, 5).join("; "))}
        </div>
      </div>`;
  }).join("");

  const more = rows.length > 40
    ? `<p style="font-size:12px;color:#9aa4ad;margin:6px 0 0 0;">
         ${rows.length - 40} more not shown. The full list is in the console.</p>` : "";

  await ChatMessage.create({
    whisper: game.users.filter(u => u.isGM).map(u => u.id),
    flags: { [MODULE_ID]: { type: "inferenceReview" } },
    content: `
      <div style="background:linear-gradient(180deg,#14110c 0%,#0b0908 100%);
                  border:2px solid #d4af37;border-radius:6px;padding:12px 14px;color:#f0e4c0;
                  font-family:'Signika','Helvetica Neue',sans-serif;">
        <div style="font-family:'Cinzel Decorative','Cinzel',serif;color:#d4af37;font-size:16px;
                    font-weight:700;letter-spacing:0.8px;border-bottom:1px solid #4a3a28;
                    padding-bottom:6px;margin-bottom:10px;">
          What ACE worked out
        </div>
        <p style="font-size:13px;color:#c0b288;margin:0 0 10px 0;line-height:1.5;">
          Nobody wrote these by hand. ACE read each item and worked out how it resolves,
          and the reasons are underneath each one. Anything wrong can be corrected once
          and it will stay corrected.
        </p>
        ${body}${more}
      </div>`,
  }).catch(err => console.warn(`${MODULE_ID} | review card failed to post:`, err));

  // The console gets the whole list, always, because a card is capped and the
  // thing he most needs is the one that did not fit.
  console.log(`${MODULE_ID} | ACE worked out ${rows.length} item(s):`);
  for (const r of rows) console.log(`${MODULE_ID} |   ${r.line}`);
}

/**
 * Correct one reading. `shape` must be a shape the pipeline can dispatch, or
 * null to say "this has no shape, leave it to the generic engine".
 */
export async function correct(item, shape) {
  if (shape !== null && !KNOWN_SHAPES.has(shape)) {
    ui.notifications?.error(`"${shape}" is not a shape ACE can run. `
      + `Valid: ${[...KNOWN_SHAPES].join(", ")}`);
    return false;
  }
  const ok = await LearnedStore.correct(item, shape);
  if (ok) {
    // ⚠️ THE CACHE HAS TO GO OR THE CORRECTION DOES NOTHING UNTIL A RELOAD, and
    // a correction that appears to be ignored is worse than no correction.
    try { game.aceQol?.SpellPipeline?._inferCache?.clear?.(); } catch (_) {}
    ui.notifications?.info(`"${item.name}" will be treated as ${shape ?? "unhandled"} from now on.`);
  }
  return ok;
}
