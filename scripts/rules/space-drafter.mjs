// ─── ACE: QOL — Space Drafter (Phase 4: the engine authors its own entries) ───
//
// The piece that makes unknown content "just work" (Johnny, 2026-07-10 05:04:
// the fey's Tricksy should never have needed a hand-authored entry). When a
// spell/feature places a template and the rules library has NO entry, this
// reads the item's OWN rules text for space signals and DRAFTS the entry —
// deterministic pattern-reading, the same proven approach the description
// parser uses for saves, venoms, and retaliation. NOT AI, NOT fuzzy matching:
// a fixed vocabulary of unambiguous phrases from the books.
//
// THE NO-SILENT-GUESSING LAW HOLDS:
//   • Draft only on an UNAMBIGUOUS signal ("magical darkness", "heavily
//     obscured", "no sound can", "difficult terrain"). Ambiguous → hands off,
//     coverage-gap log, exactly as before.
//   • Every draft leaves a PAPER TRAIL: the entry is stamped onto the item
//     (the existing per-item rules-override flag — permanent, editable,
//     survives reloads) AND the GM gets a whispered receipt card naming what
//     was read and decided, with the one-step way to overrule it.
//
// Signals recognized (v1 — the space vocabulary):
//   magical darkness   → heavy obscurement, magicalDarkness kind, real dark,
//                        pierced by Devil's Sight / truesight / blindsight
//   plain darkness     → same, but DARKVISION also pierces it (RAW)
//   heavily obscured / fog / mist / smoke → heavy obscurement, fog kind,
//                        pierced by blindsight only
//   lightly obscured   → light obscurement (no attack penalty; Phase-2 aware)
//   no sound / silence → silence (verbal casting blocked inside — live gate)
//   difficult terrain  → movement-cost region (honors the table setting)
// ──────────────────────────────────────────────────────────────────────────────

import { MODULE_ID } from "../ace-qol.mjs";

export class SpaceDrafter {

  /** Item uuids we've already drafted-or-declined this session (spam guard). */
  static _seen = new Set();

  /**
   * Read the item's rules text and draft a space entry, or return null when
   * no unambiguous signal exists. Pure — the caller persists/notifies.
   */
  static infer(item) {
    const raw = String(item?.system?.description?.value ?? "");
    if (!raw) return null;
    const text = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").toLowerCase();
    if (text.length < 20) return null;

    const space = {
      obscurement: null, kind: null, pierceBy: [],
      silence: false, difficultTerrain: null, light: null,
    };
    const readings = [];   // plain-English receipt lines

    // ── Darkness — magical vs plain (the distinction is load-bearing RAW:
    //    darkvision pierces PLAIN darkness, never magical) ──
    const magicalDark = /magical\s+darkness/.test(text)
      || (/darkness/.test(text) && /(?:nonmagical\s+light\s+can'?t|darkvision\s+can'?t\s+(?:see|penetrate))/.test(text));
    const plainDark = !magicalDark
      && /(?:fills?|creates?|spreads?)[^.]{0,60}\bdarkness\b|\barea\s+of\s+darkness\b/.test(text);
    if (magicalDark || plainDark) {
      space.obscurement = "heavy";
      space.kind = "magicalDarkness";
      space.light = { mode: "override", level: 1 };
      space.pierceBy = magicalDark
        ? ["devilsSight", "truesight", "blindsight"]
        : ["darkvision", "devilsSight", "truesight", "blindsight"];
      readings.push(magicalDark
        ? "creates MAGICAL DARKNESS (darkvision can't pierce; Devil's Sight/truesight/blindsight can)"
        : "creates darkness (darkvision pierces — it isn't magical)");
    }

    // ── Fog / heavy obscurement (only when it isn't the darkness above) ──
    if (!space.obscurement && (/heavily\s+obscured?/.test(text)
        || /(?:fog|mist|smoke|cloud)[^.]{0,80}obscur/.test(text))) {
      space.obscurement = "heavy";
      space.kind = "fog";
      space.pierceBy = ["blindsight"];
      readings.push("makes the area HEAVILY OBSCURED (sight blocked; blindsight pierces)");
    }

    // ── Light obscurement ──
    if (!space.obscurement && /lightly\s+obscured?/.test(text)) {
      space.obscurement = "light";
      readings.push("makes the area lightly obscured");
    }

    // ── Silence ──
    if (/no\s+sound\s+can\s+be\s+created|sound\s+can(?:'t|not)\s+(?:be\s+created|pass)|no\s+sound\s+(?:can\s+)?pass/.test(text)) {
      space.silence = true;
      space.stampInside = ["deafened"];
      readings.push("SILENCES the area (deafened while inside; verbal casting impossible)");
    }

    // ── Difficult terrain ──
    if (/difficult\s+terrain/.test(text)) {
      space.difficultTerrain = 2;
      readings.push("ground becomes DIFFICULT TERRAIN");
    }

    if (!readings.length) return null;   // no unambiguous signal → hands off

    return {
      entry: {
        srd: false,
        drafted: true,                    // provenance: authored by the engine
        draftedAt: Date.now(),
        concentration: !!(item.system?.properties?.has?.("concentration") || item.system?.duration?.concentration),
        space,
        notes: `Auto-drafted by the ACE rules engine from the item's own rules text (${new Date().toISOString().slice(0, 10)}). Edit or clear the item's ACE rules flag to overrule.`,
      },
      readings,
    };
  }

  /**
   * Full flow for an unknown template item: infer → persist onto the item
   * (the existing per-item rules-override flag — the lookup path already
   * honors it, so every future cast hits it like a library entry) → whisper
   * the GM a receipt. Returns the entry or null.
   */
  static async draftForItem(item) {
    try {
      if (!item?.uuid || SpaceDrafter._seen.has(item.uuid)) {
        return item?.flags?.[MODULE_ID]?.rulesEntry ?? null;
      }
      SpaceDrafter._seen.add(item.uuid);

      const draft = SpaceDrafter.infer(item);
      if (!draft) {
        console.log(`${MODULE_ID} | [space-drafter] "${item.name}": no unambiguous space signal in its text — hands off (coverage gap stands)`);
        return null;
      }

      // Persist — permanent, editable, visible in the item's flags. Only the
      // GM side writes (synthetic token items accept owner/GM writes; this
      // flow runs on the activeGM client via space-effects).
      try {
        await item.setFlag(MODULE_ID, "rulesEntry", draft.entry);
      } catch (err) {
        console.warn(`${MODULE_ID} | [space-drafter] could not persist entry onto "${item.name}" (using it for this cast anyway):`, err);
      }

      // The receipt — a GM whisper naming exactly what was read and decided.
      try {
        const lines = draft.readings.map(r => `<li>${foundry.utils.escapeHTML(r)}</li>`).join("");
        await ChatMessage.create({
          whisper: ChatMessage.getWhisperRecipients?.("GM") ?? [],
          content: `
            <div style="border:1px solid #c9a76b;border-radius:6px;padding:8px 10px;background:#141118;color:#e8dcc3;font-size:14px;">
              <div style="font-weight:700;color:#c9a76b;"><i class="fas fa-brain"></i> ACE Rules Engine — new rule learned</div>
              <div style="margin:4px 0;">Read <b>${foundry.utils.escapeHTML(item.name)}</b> and determined it:</div>
              <ul style="margin:2px 0 6px 18px;padding:0;">${lines}</ul>
              <div style="font-size:12px;color:#9c8f74;">Saved onto the item — it behaves this way from now on. Wrong? Say so and it gets corrected.</div>
            </div>`,
          flags: { [MODULE_ID]: { rulesDrafterReceipt: true } },
        });
      } catch (_) { /* receipt is best-effort — the console line below always fires */ }

      console.log(`${MODULE_ID} | [space-drafter] "${item.name}" → DRAFTED: ${draft.readings.join("; ")}`);
      return draft.entry;
    } catch (err) {
      console.warn(`${MODULE_ID} | [space-drafter] draft failed (hands off, non-fatal):`, err);
      return null;
    }
  }
}
