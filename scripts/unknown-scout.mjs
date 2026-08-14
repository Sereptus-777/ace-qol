// ─── ACE QOL — Unknown item scout ─────────────────────────────────────────────
//
// When somebody uses a spell or a feature ACE's registry has never heard of, the
// GM gets a quiet whisper saying so — and a direct link to how the two big
// community automation libraries handled that exact thing.
//
// Johnny asked for this on 2026-08-13, and the reasoning is his:
//
//   "This will make our work a lot easier and a lot faster."
//
// He is right. Both libraries are years of people arguing about how a spell
// actually resolves at the table. Reading their reasoning before we write ours
// is free research, and it turns "I noticed Chain Lightning did nothing" into
// "here is the entry to write" without anyone having to go looking.
//
// ⚠️ READ THEIR REASONING, NOT THEIR CODE. Both are MIT so we MAY reuse with
// attribution — unlike Token Magic FX, which is GPL and would force ACE
// open-source. But their automations are written against Midi's pipeline and its
// assumptions; ACE's registry is declarative and grouped by BEHAVIOUR, so a
// direct port is usually the wrong shape anyway. Take the ruling, write it our
// way. See rule_check_premades_before_writing_a_spell.md.
//
// ⚠️ NEVER INSTALL THOSE MODULES ENABLED. They depend on Midi-QOL, DAE, socketlib
// and Times Up — a complete second automation engine intercepting the same rolls
// ACE does. Keep a copy on disk with the module switched OFF, or read GitHub.
// ──────────────────────────────────────────────────────────────────────────────

// ⚠️ DECLARED LOCALLY, NOT IMPORTED. ace-qol.mjs imports this file, so importing
// MODULE_ID back from it forms a cycle and the binding is unassigned while this
// file evaluates — the temporal-dead-zone crash that made every token unclickable
// on 2026-08-11. See lesson notes on prone-art.mjs.
const MODULE_ID = "ace-qol";
const LOG = "ace-qol | UnknownScout";

/** The two libraries, and where to look inside each. */
const LIBRARIES = [
  { label: "Chris's Premades", repo: "chrisk123999/chris-premades" },
  { label: "Midi Item Showcase", repo: "txm3278/midi-item-showcase-community" },
];

/**
 * dnd5e item types worth reporting.
 *
 * ⚠️ SPELL AND FEAT ONLY, DELIBERATELY. In dnd5e "feat" is the type behind class
 * features, race/species features, monster features AND feats — five of the seven
 * categories those libraries ship. Weapons, equipment and consumables are NOT
 * here: ACE handles those through the weapon rules and the damage engine, so
 * reporting them as "unknown" would be a lie about our own coverage.
 */
const WATCHED_TYPES = new Set(["spell", "feat"]);

export class UnknownScout {

  /** One report per item per session. Key is `type:name`. */
  static _seen = new Set();

  /** Build a GitHub code-search link for this name inside one repo. */
  static _searchUrl(repo, name) {
    const q = encodeURIComponent(`repo:${repo} "${name}"`);
    return `https://github.com/search?q=${q}&type=code`;
  }

  /**
   * Does ACE already cover this, ANYWHERE?
   *
   * ⚠️ 🔴 ASK EVERY REGISTRY, NOT JUST ONE. Built 2026-08-13 asking only the
   * spell pipeline, and Johnny caught it inside five minutes: "I was surprised
   * to see Counterspell first in the list. We definitely have that." He was
   * right. ACE's coverage lives in at least two places:
   *
   *   • spell-pipeline/registry  — 125 entries. What HAPPENS when you cast it.
   *   • target-state-registry    — ~620 entries across spell effects, class
   *                                features, racial features, magic items,
   *                                artifacts and backgrounds. What the thing
   *                                DOES to a creature's state.
   *
   * A scout that knows about one and not the other reports covered features as
   * missing — which is worse than useless, because it sends him researching
   * something already built. Both, or say nothing.
   */
  static async _isKnown(item) {
    const name = item?.name;
    let asked = false;

    try {
      const { SpellPipeline } = await import("./spell-pipeline/pipeline.mjs");
      asked = true;
      if (SpellPipeline.ownsSpell(item) === true) return true;
    } catch (err) {
      console.warn(`${LOG} | could not consult the spell pipeline.`, err);
    }

    try {
      const { findByName } = await import("./target-state-registry/_index.mjs");
      asked = true;
      if (findByName(name)) return true;
    } catch (err) {
      console.warn(`${LOG} | could not consult the target-state registry.`, err);
    }

    // ⚠️ If NOTHING could be asked, say nothing. A scout that cries "unknown"
    // because its own imports failed manufactures a false gap — the exact
    // false-root-cause this codebase keeps getting bitten by. Silence is the
    // only honest answer to a failed read.
    if (!asked) {
      console.warn(`${LOG} | no registry could be consulted — staying quiet about "${name}".`);
      return true;
    }
    return false;
  }

  static async _report(item) {
    const name = String(item?.name ?? "").trim();
    if (!name) return;
    const type = item.type === "feat" ? "feature" : "spell";
    const key = `${item.type}:${name.toLowerCase()}`;
    if (UnknownScout._seen.has(key)) return;
    UnknownScout._seen.add(key);

    const esc = foundry.utils.escapeHTML(name);
    const links = LIBRARIES.map(l =>
      `<a href="${UnknownScout._searchUrl(l.repo, name)}" target="_blank" rel="noopener"
          style="color:#ffd970;text-decoration:underline;">${l.label}</a>`
    ).join(" &nbsp;·&nbsp; ");

    // Dark wrapper + ACE's gold. Body 16px, heading 18px, hint 14px — Foundry's
    // own chrome is light and light-on-light is the documented mistake.
    await ChatMessage.create({
      whisper: ChatMessage.getWhisperRecipients("GM").map(u => u.id),
      content: `<div style="background:#141519;border-left:4px solid #d4af37;border-radius:6px;padding:12px 14px;">
          <div style="color:#d4af37;font-size:18px;font-weight:700;letter-spacing:.03em;">
            Not in ACE's library yet
          </div>
          <div style="color:#f0e4c0;font-size:16px;line-height:1.5;margin:6px 0 8px;">
            <strong style="color:#ffd970;">${esc}</strong> — this ${type} ran on dnd5e's
            defaults. ACE did not automate it.
          </div>
          <div style="color:#b3a888;font-size:14px;line-height:1.5;">
            See how the community solved it: ${links}
          </div>
        </div>`,
      flags: { [MODULE_ID]: { type: "unknownScout", itemName: name, itemType: item.type } },
    });

    console.log(`${LOG} | "${name}" (${item.type}) is not in the registry.`);
  }

  static register() {
    const onUse = (activity) => {
      // ⚠️ ACTIVE GM ONLY, and never block the action. This watches; it must
      // never delay or cancel somebody's turn.
      try {
        if (game.users?.activeGM !== game.user) return;
        const item = activity?.item;
        if (!item || !WATCHED_TYPES.has(item.type)) return;
        // Fire and forget — the use proceeds regardless.
        UnknownScout._isKnown(item).then(known => {
          if (!known) UnknownScout._report(item).catch(() => {});
        }).catch(() => {});
      } catch (err) {
        console.warn(`${LOG} | scout failed (harmless):`, err);
      }
    };

    Hooks.on("dnd5e.preUseActivity", onUse);

    // A fresh session forgets what it has already reported.
    const reset = () => UnknownScout._seen.clear();
    if (game.ready) reset();
    else Hooks.once("ready", reset);

    console.log(`${LOG} | online — watching spells and features`);
  }

  /** Console helper: what has it flagged this session? */
  static seen() { return [...UnknownScout._seen]; }
}
