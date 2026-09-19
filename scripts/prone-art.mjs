// ─── ACE QOL — Prone art ──────────────────────────────────────────────────────
//
// When a creature goes prone, swap its TOKEN ARTWORK for a picture of it lying
// down — not an arrow icon stuck on a token that still looks like it is standing
// there ready to fight.
//
// Johnny, 2026-08-11: "I used to do it with MapTool… it's way better than just
// some arrows because it looks like the frickin' token image still looks like
// it's standing and ready to fight, so the visual is compelling."
//
// ═══ THIS IS THE DEAD-ART SYSTEM, WEARING A DIFFERENT HAT ════════════════════
//
// Same folder shape, same filenames, and — critically — THE SAME NORMALISER.
// `DeathPipeline.normaliseKey` is imported rather than reimplemented, because
// writing a second one is precisely how the corpse art broke: the resolver
// hyphenated the creature's name while the cache kept the raw filename, so
// `dead-stone golem.png` could never meet `dead-stone-golem`, and SIXTEEN of
// Johnny's eighty-two corpses were unreachable — every file with a space in it.
// Silently, because falling through to generic art looks deliberate.
//
//   Assets/Prone/Prone-Goblin.png
//   Assets/Prone/Prone-Carrion Crawler.png     ← spaces are fine
//   Assets/Prone/Prone-Goblin-2.png            ← a variant, picked at random
//   Assets/Dead/Fiend/dead-fiend.png           ← counts too (2026-09-18): every
//                                                image in his prone folders does
//
// The order is his: the creature's name, then its type, then its race or
// subtype. Art made for lying down beats a corpse picture of the same name.
//
// ⚠️ NO ANIMATION. He asked for the image and nothing else. A creature that has
// just been knocked down does not need a flourish; the art IS the feedback.
//
// ⚠️ THE ORIGINAL ART IS REMEMBERED ON THE TOKEN, not recomputed. A creature
// that stands up must go back to exactly what it was wearing — which may be a
// wildcard roll, a polymorph, or a token-art override the GM picked by hand.
// Guessing it back from the actor's prototype would quietly undo all of those.
// ──────────────────────────────────────────────────────────────────────────────

import { DeathPipeline } from "./death-pipeline.mjs";

// ⚠️ DECLARED LOCALLY, NOT IMPORTED — AND THIS IS NOT A STYLE CHOICE.
// `ace-qol.mjs` imports THIS file, so the two form a cycle. Every import is
// evaluated before the importing module's own body runs, which means
// `ace-qol.mjs`'s `export const MODULE_ID` has NOT been assigned yet while this
// file is being evaluated. Using an imported MODULE_ID in a module-level
// template literal therefore throws a temporal-dead-zone ReferenceError, which
// aborts `ace-qol.mjs` entirely — so MODULE_ID is never initialised, and every
// later reference to it anywhere in the module fails too.
//
// Live consequence (2026-08-11): Johnny could not select a single token. Each
// left click threw "Cannot access 'MODULE_ID' before initialization" from
// lootable-tile's click handler — a file that had nothing to do with the
// change. The whole module was dead and only the click handler was loud.
//
// `death-pipeline.mjs` declares its own const for exactly this reason. Any file
// that needs MODULE_ID at EVALUATION time must do the same; importing it is
// only safe inside functions, which run long after both modules have settled.
const MODULE_ID = "ace-qol";

const LOG = "ace-qol | ProneArt";
const PRONE_ART_PATH = `modules/${MODULE_ID}/Assets/Prone`;
/** Where the token's standing artwork is parked while it is down. */
const FLAG_PREV = "proneArtPrevious";

export class ProneArt {

  /** The index (see `indexFiles`). Built once, refreshed on demand. */
  static _cache = null;

  /* ─── The index ───────────────────────────────────────────────────────── */

  /**
   * ⚠️ A CACHE THAT CANNOT NOTICE A RESCAN IS A CACHE THAT GOES STALE FOREVER.
   * The art module can be rescanned at any moment from its own dialog, and the
   * old code held whatever it indexed the first time a creature fell over. The
   * fingerprint is the source's size plus its first and last path, which changes
   * whenever the folder list or its contents do.
   */
  static _fingerprint(paths) {
    return `${paths.length}|${paths[0] ?? ""}|${paths[paths.length - 1] ?? ""}`;
  }

  /** ACE Token Art's prone index, built on demand. Null when it is not there. */
  static async _artModuleIndex() {
    const mod = game.modules?.get?.("ace-token-art");
    if (!mod?.active) return null;
    const api = mod.api;
    if (typeof api?.getProneIndex !== "function") {
      console.warn(`${LOG} | ACE Token Art is active but exposes no prone index, so its `
        + `"Prone Art Folders" setting cannot be read. Falling back to ${PRONE_ART_PATH}.`);
      return null;
    }
    let idx = api.getProneIndex();
    // Not built yet - ask, once, rather than reporting "no art" for a folder
    // that simply has not been read at this point in the load.
    if (!idx?.ready && typeof api.rescanProneArt === "function") {
      try { await api.rescanProneArt({ silent: true }); idx = api.getProneIndex(); }
      catch (err) { console.warn(`${LOG} | asking ACE Token Art to build its prone index failed:`, err); }
    }
    return idx ?? null;
  }

  static async buildCache({ force = false } = {}) {
    if (this._cache && !force) {
      // Cheap staleness check against the art module before trusting the cache.
      try {
        const idx = game.modules?.get?.("ace-token-art")?.api?.getProneIndex?.();
        if (idx?.ready) {
          const fp = this._fingerprint((idx.all ?? []).map(e => e.path));
          if (fp !== this._sourceFingerprint) force = true;
        }
      } catch (_) { /* an unreadable index is not a reason to throw the cache away */ }
    }
    if (this._cache && !force) return this._cache;
    let cache = ProneArt.indexFiles([]);
    try {
      const FP = foundry.applications?.apps?.FilePicker?.implementation
              ?? globalThis.FilePicker;
      if (!FP?.browse) {
        // ⚠️ Never let "the API is missing" print as "you have no art".
        console.error(`${LOG} | No FilePicker available — prone art cannot be indexed. That is a Foundry API problem, not a missing folder.`);
        this._cache = cache;
        return cache;
      }

      const seen = [];

      // ⚠️🔴 ACE TOKEN ART OWNS THE FOLDER LIST. Johnny, 2026-09-02: "our prone
      // pipeline has got to check the folders in Ace token art." Its Prone tab
      // has a "Prone Art Folders" setting, and if this kept walking its own
      // hardcoded path regardless then the moment he pointed that setting
      // anywhere else the picker would show art this resolver could never find,
      // and matching by creature name would quietly stop working while the tab
      // looked full.
      //
      // ⚠️ AND IT MUST NOT FALL BACK QUIETLY WHEN THAT LIST COMES BACK EMPTY.
      // The first version did, so "the art module's folders are misconfigured"
      // and "the art module is not installed" produced identical behaviour and
      // identical silence - which is exactly how his folders came to be scanned
      // by nobody while the rescan reported success.
      const taIndex = await ProneArt._artModuleIndex();
      if (taIndex) {
        for (const e of (taIndex.all ?? [])) if (e?.path) seen.push(e.path);
        if (seen.length) {
          console.log(`${LOG} | using ACE Token Art's prone folders (${seen.length} file(s)).`);
        } else {
          let configured = [];
          try { configured = game.settings.get("ace-token-art", "tokenArtProneFolders") ?? []; }
          catch (_) { /* reported as unknown below */ }
          console.warn(`${LOG} | ACE Token Art is in charge of prone folders and its index is `
            + `EMPTY. Configured: ${configured.length ? configured.join(", ") : "(none)"}. `
            + `No creature will get prone art until that list points at images. `
            + `Set it under "Prone Art Folders", or in the folder dialog's Prone tab.`);
        }
      } else {
        // Standalone: ace-qol must still work with the art module absent.
        console.log(`${LOG} | ACE Token Art is not available, so prone art comes from `
          + `${PRONE_ART_PATH} instead.`);
        const walk = async (dir) => {
          const res = await FP.browse("data", dir);
          for (const f of res.files ?? []) seen.push(f);
          for (const sub of res.dirs ?? []) {
            try { await walk(sub); }
            catch (err) { console.warn(`${LOG} | could not scan "${sub}":`, err); }
          }
        };
        await walk(PRONE_ART_PATH);
      }
      this._sourceFingerprint = ProneArt._fingerprint(seen);

      const index = ProneArt.indexFiles(seen);
      cache = index;

      const from = taIndex ? "ACE Token Art's prone folders" : PRONE_ART_PATH;
      console.log(`${LOG} | indexed ${index.files} image(s) from ${from}: ${index.byKind.prone} named prone-, `
        + `${index.byKind.dead} named dead-, ${index.byKind.plain} with no prefix → ${index.exact.size} name(s), `
        + `${index.fragments.size} word(s).`);
      if (!seen.length) {
        console.log(`${LOG} | nothing in ${from} yet — drop images named "Prone-Goblin.png" in there.`);
      }
    } catch (err) {
      // ⚠️ Say which of the two it is. "Absent" and "broken" must never print
      // the same message.
      const msg = String(err?.message ?? err ?? "");
      if (/not exist|ENOENT|404/i.test(msg)) {
        console.log(`${LOG} | ${PRONE_ART_PATH} does not exist yet — create it and drop art in.`);
      } else {
        console.error(`${LOG} | failed to index prone art:`, err);
      }
    }
    this._cache = cache;
    return cache;
  }

  /* ─── The files ───────────────────────────────────────────────────────── */

  /**
   * What a file in the prone folders is, read from how it is named: art made
   * for lying down (`prone-`), a corpse (`dead-`), or neither.
   *
   * ⚠️🔴 EVERY FILE IN THE FOLDER COUNTS, NOT ONLY `prone-` ONES (Johnny,
   * 2026-09-18). His prone folders are Assets/Prone AND Assets/Dead, and this
   * used to strip only a `prone-` prefix, so `dead-fiend.png` was filed under
   * "dead-fiend" and no creature ever asked for that. Neferon fell thirty feet,
   * was prone, and showed nothing: no picture matched, and the prone icon is
   * hidden for everybody by his 2026-09-02 rule.
   */
  static _kindOf(stem) {
    if (/^prone[-_ ]*/i.test(stem)) return "prone";
    if (/^dead[-_ ]+/i.test(stem)) return "dead";
    return "plain";
  }

  /**
   * Index image paths into names and words. Pure, so the self-test runs it on
   * his real folder listing.
   *
   * A file answers to its whole name (`dead-arcanaloth-fiend` → "arcanaloth-
   * fiend", and "fiend" for `dead-fiend-11`, a numbered variant) and, like the
   * corpse index, to each word in it and each pair of words ("arcanaloth",
   * "fiend"). A whole name always outranks a word borrowed from a longer one:
   * a fiend gets `dead-fiend.png`, never the arcanaloth's picture.
   *
   * @returns {{ exact: Map<string, object[]>, fragments: Map<string, object[]>,
   *             files: number, byKind: {prone: number, dead: number, plain: number} }}
   */
  static indexFiles(paths) {
    const RANK = { prone: 3, plain: 2, dead: 1 };
    const exact = new Map(), fragments = new Map();
    const byKind = { prone: 0, dead: 0, plain: 0 };
    let files = 0;
    const add = (map, key, entry) => {
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      const list = map.get(key);
      if (!list.some(e => e.path === entry.path)) list.push(entry);
    };
    for (const path of (paths ?? [])) {
      if (!/\.(png|webp|jpe?g|gif|avif)$/i.test(String(path))) continue;   // no .psd, no video
      const raw = String(path).split("/").pop().replace(/\.[^.]+$/, "");
      let stem = raw;
      try { stem = decodeURIComponent(raw); } catch (_) { /* a stray % in a filename is still a filename */ }
      const kind = ProneArt._kindOf(stem);
      const norm = DeathPipeline.normaliseKey(stem.replace(/^prone[-_ ]*/i, "").replace(/^dead[-_ ]+/i, ""));
      if (!norm) continue;
      const bare = DeathPipeline.stripVariant(norm);
      const words = bare.split("-").filter(w => w.length > 2 && !/^\d+$/.test(w));
      const entry = { path, kind, rank: RANK[kind], size: words.length };
      files++;
      byKind[kind]++;
      add(exact, norm, entry);
      add(exact, bare, entry);
      for (let i = 0; i < words.length; i++) {
        add(fragments, words[i], entry);
        if (i + 1 < words.length) add(fragments, `${words[i]}-${words[i + 1]}`, entry);
      }
    }
    return { exact, fragments, files, byKind };
  }

  /* ─── Matching ────────────────────────────────────────────────────────── */

  /**
   * What to ask the index for, in order.
   *
   * ⚠️ HIS ORDER (2026-09-18): the creature's name, then its type ("fiend"),
   * then its race or subtype ("yugoloth"). Neferon has no picture of his own,
   * so he reaches the type and gets `dead-fiend.png`.
   *
   * ⚠️ THE FIRST-NAME STEP IS ONLY FOR ART MADE FOR IT. Johnny names prone
   * pictures by first name — `prone-firaxis.png` while the actor is "Firaxis
   * Greenbeard" — so a name also walks back word by word. A corpse picture is
   * named for a KIND of creature instead, and the first word of a longer name
   * is not its kind: walked back, a Giant Frog would have been a dead giant.
   * So the walk-back never reaches a `dead-` file.
   *
   * @returns {{key: string, words: boolean, minRank: number}[]}
   */
  static triesFor(actor) {
    const tries = [];
    const seen = new Set();
    const ask = (key, { words = true, minRank = 1 } = {}) => {
      if (!key) return;
      const id = `${key}|${words}|${minRank}`;
      if (seen.has(id)) return;
      seen.add(id);
      tries.push({ key, words, minRank });
    };
    const whole = (v) => DeathPipeline.normaliseKey(v);
    // "Arcanaloth (Legacy)" is an arcanaloth, and "Goblin 3" is a goblin.
    const base = (v) => DeathPipeline.normaliseKey(
      String(v ?? "").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s*\d+\s*$/g, "").trim());

    // ── 1. The creature's name ──
    // A flavour name ("Grish the Unwashed") must not lose the creature: the
    // identity rule keeps the real creature on the actor, so read it too.
    const names = [actor?.name, actor?.prototypeToken?.name, actor?.getFlag?.(MODULE_ID, "creatureBase")]
      .filter(v => typeof v === "string" && v.trim());
    for (const n of names) { ask(whole(n)); ask(base(n)); }
    for (const n of names) {
      const parts = base(n).split("-").filter(Boolean);
      for (let k = parts.length - 1; k >= 1; k--) ask(parts.slice(0, k).join("-"), { words: false, minRank: 2 });
    }

    // ── 2. The type ──
    const rawType = actor?.system?.details?.type;
    const typeValue = typeof rawType === "string" ? rawType
      : (rawType?.value === "custom" ? rawType?.custom : rawType?.value);
    ask(whole(typeValue));

    // ── 3. Race, then subtype ──
    // ⚠️ dnd5e 5.x keeps the race as the species ITEM once prepared (a
    // local-document field), and as its raw id when that item is missing. The
    // old code turned the item into text and asked for "object-object".
    const race = actor?.system?.details?.race;
    const raceName = typeof race === "string" ? (/^[A-Za-z0-9]{16}$/.test(race) ? "" : race) : race?.name;
    ask(whole(raceName));
    const subtype = typeof rawType === "string" ? "" : rawType?.subtype;
    for (const part of String(subtype ?? "").split(/,|\/|\band\b/i)) ask(whole(part));

    return tries;
  }

  /**
   * The picture for this creature from an index, or null. Pure.
   *
   * For each question in order: a file of that exact name first, then one
   * that has it as a word. Art made for lying down beats a corpse of the same
   * name. Several numbered variants of one name are picked from at random so
   * nine goblins are not identical; among borrowed words, the file most about
   * that word wins (`dead-wolf-grey` over `dead-Animal Lord (Wolf)` for a wolf).
   *
   * @returns {{path: string, key: string, how: "name"|"word"} | null}
   */
  static pickFrom(index, tries, rand = Math.random) {
    const best = (list, minRank) => {
      const ok = (list ?? []).filter(e => e.rank >= minRank);
      if (!ok.length) return [];
      const top = Math.max(...ok.map(e => e.rank));
      return ok.filter(e => e.rank === top);
    };
    for (const t of tries) {
      const named = best(index?.exact?.get?.(t.key), t.minRank);
      if (named.length) {
        const e = named[Math.min(named.length - 1, Math.floor(rand() * named.length))];
        return { path: e.path, key: t.key, how: "name" };
      }
      if (!t.words) continue;
      const worded = best(index?.fragments?.get?.(t.key), t.minRank)
        .sort((a, b) => (a.size - b.size) || String(a.path).localeCompare(String(b.path)));
      if (worded.length) return { path: worded[0].path, key: t.key, how: "word" };
    }
    return null;
  }

  /**
   * The best prone image for this creature, or null.
   * Its own name first, then its type, then its race or subtype.
   */
  static async artFor(actor) {
    // ⚠️🔴 THE PICK IS READ BEFORE THE INDEX, AND THE ORDER IS THE POINT.
    // ACE Token Art's Prone tab writes this flag. A GM who chose a picture for
    // this creature has already answered the question the name matching below
    // is guessing at, so `prone-goblin.png` must never override it.
    //
    // ⚠️ AND IT IS READ BEFORE THE EMPTY-INDEX BAIL. Checking it further down
    // meant a GM with an empty prone folder and a deliberately picked file got
    // nothing at all: the guard returned null before the flag was ever looked
    // at. The pick does not need the index to exist.
    const picked = actor?.getFlag?.(MODULE_ID, "proneArt");
    if (picked) return picked;

    const index = await this.buildCache();
    if (!index?.files) return null;
    return ProneArt.pickFrom(index, ProneArt.triesFor(actor))?.path ?? null;
  }

  /** The questions asked for this creature, as one line for the console. */
  static _asked(actor) {
    return [...new Set(ProneArt.triesFor(actor).map(t => t.key))].join(", ") || "(nothing to ask)";
  }

  /* ─── The swap ────────────────────────────────────────────────────────── */

  /** A corpse is not prone, and a corpse's texture belongs to the death pipeline. */
  static _isDead(tokenDoc) {
    return !!(tokenDoc?.flags?.[MODULE_ID]?.isDead
           || tokenDoc?.actor?.statuses?.has?.("dead"));
  }

  static async goProne(tokenDoc) {
    try {
      if (game.users?.activeGM !== game.user) return;        // one writer
      if (tokenDoc?.getFlag?.(MODULE_ID, FLAG_PREV)) return; // already down
      if (ProneArt._isDead(tokenDoc)) return;                // corpses stay corpses

      const art = await this.artFor(tokenDoc?.actor);
      if (!art) {
        // ⚠️ SAY IT. The prone icon is hidden for everybody, so a creature with
        // no picture shows nothing at all, and that looked exactly like the
        // condition never landing (Neferon, 2026-09-18).
        const files = this._cache?.files ?? 0;
        console.log(`${LOG} | ${tokenDoc?.name} is prone, but `
          + (files ? `no prone art matched (asked for: ${ProneArt._asked(tokenDoc?.actor)}).`
                  : `the prone folders have no images indexed.`)
          + ` The prone icon is hidden, so the token shows nothing.`);
        return;
      }

      const current = tokenDoc.texture?.src;
      if (!current || current === art) return;

      await tokenDoc.update({
        "texture.src": art,
        [`flags.${MODULE_ID}.${FLAG_PREV}`]: current,
      });
      console.log(`${LOG} | ${tokenDoc.name} goes prone → ${art}`);
    } catch (err) {
      console.error(`${LOG} | could not swap ${tokenDoc?.name} to prone art — the condition still applied.`, err);
    }
  }

  static async standUp(tokenDoc) {
    try {
      if (game.users?.activeGM !== game.user) return;
      const previous = tokenDoc?.getFlag?.(MODULE_ID, FLAG_PREV);
      if (!previous) return;                                 // we never swapped it

      // ⚠️ NEVER RESTORE OVER A CORPSE — AND DO NOT RELY ON HOOK ORDER TO
      // AVOID IT. If the prone effect is removed for ANY reason after death —
      // the GM clearing it, dnd5e tidying up, another module — this would put
      // the creature's STANDING art back on top of the dead-token art the death
      // pipeline just painted. Checking the durable `isDead` flag holds however
      // the events happen to interleave; a "clear the memory on death" hook only
      // holds if it wins the race.
      if (ProneArt._isDead(tokenDoc)) {
        try { await tokenDoc.unsetFlag?.(MODULE_ID, FLAG_PREV); } catch (_) {}
        console.log(`${LOG} | ${tokenDoc.name} is dead — leaving the corpse art alone.`);
        return;
      }

      await tokenDoc.update({
        "texture.src": previous,
        [`flags.${MODULE_ID}.-=${FLAG_PREV}`]: null,
      });
      console.log(`${LOG} | ${tokenDoc.name} stands up → ${previous}`);
    } catch (err) {
      console.error(`${LOG} | could not restore ${tokenDoc?.name}'s standing art.`, err);
    }
  }

  /**
   * ⚠️ HIDE THE PRONE ICON ON TOKENS WHOSE ART WE SWAPPED.
   * Johnny, 2026-08-11: "I'm still getting those arrows above their heads."
   * The whole point of this feature is that the ARTWORK says "down" — a red
   * arrow badge on top of a picture of a man lying on his back is the icon we
   * set out to replace, still there. Foundry draws status icons on the canvas
   * (PIXI, not DOM), so CSS cannot touch them; the icon has to be removed from
   * the sprite container after Foundry builds it.
   *
   * ⚠️ EVERY PRONE TOKEN NOW, NOT ONLY THE ONES WE SWAPPED. It used to leave
   * the badge on a creature with no prone art so it would have SOME indicator,
   * and the orbiting arrows were the other half of that. Johnny removed both on
   * 2026-09-02: "I don't want anything drawing prone, including us." So the
   * badge goes for everybody, and a creature with no prone art shows nothing.
   */
  static _hideProneBadge(token) {
    try {
      const kids = token?.effects?.children ?? [];
      for (const child of kids) {
        const src = child?.texture?.baseTexture?.resource?.src
                 ?? child?.texture?.textureCacheIds?.[0] ?? "";
        if (/statuses\/prone|prone\.svg/i.test(String(src))) {
          child.renderable = false;
          child.visible = false;
        }
      }
    } catch (_) { /* a stray badge is far better than a broken token */ }
  }

  /* ─── Wiring ──────────────────────────────────────────────────────────── */

  static register() {
    // Foundry rebuilds the effect sprites on every refresh, so re-hide each time.
    Hooks.on("drawToken",    (t) => ProneArt._hideProneBadge(t));
    Hooks.on("refreshToken", (t) => ProneArt._hideProneBadge(t));
    const onEffect = async (effect, going) => {
      try {
        if (!effect?.statuses?.has?.("prone")) return;
        const actor = effect.parent instanceof Actor ? effect.parent
                    : (effect.parent?.parent instanceof Actor ? effect.parent.parent : null);
        if (!actor) return;
        for (const token of actor.getActiveTokens?.(true) ?? []) {
          const doc = token.document ?? token;
          if (going === "down") await ProneArt.goProne(doc);
          else                  await ProneArt.standUp(doc);
        }
      } catch (err) {
        console.warn(`${LOG} | prone hook failed (non-fatal):`, err);
      }
    };
    Hooks.on("createActiveEffect", (e) => onEffect(e, "down"));
    Hooks.on("deleteActiveEffect", (e) => onEffect(e, "up"));

    // ⚠️ TURNING A CONDITION OFF DOES NOT ALWAYS DELETE IT.
    // Johnny, 2026-08-11: "taking off the prone condition does not bring back
    // the original token art." Listening only for DELETE was the bug — the
    // effect is often just DISABLED, so no delete ever fires and the creature
    // stays face-down forever.
    //
    // This is almost certainly the same mechanism behind the disabled
    // `dnd5eprone000000` ghosts found on Firaxis and Strahd the same evening:
    // something switches these records off instead of removing them, which
    // leaves them invisible in `actor.statuses` AND permanently blocking any
    // future attempt to apply the condition. Watching `updateActiveEffect`
    // covers both spellings of "off".
    Hooks.on("updateActiveEffect", (effect, changes) => {
      if (!("disabled" in (changes ?? {}))) return;
      onEffect(effect, changes.disabled ? "up" : "down");
    });

    // A creature that dies while prone: the death pipeline owns the texture
    // from here, so forget what it was wearing.
    // ⚠️ THIS HOOK HANDS LISTENERS AN OBJECT, NOT A TOKEN. It fires as
    // `{ actor, tokenDoc, changes, killerName, ... }` — the first draft here
    // treated the payload as a TokenDocument and called `unsetFlag` on it,
    // which silently did nothing. This is tidy-up only; the guard that actually
    // protects the corpse is the isDead check in `standUp`, which does not care
    // when this runs.
    Hooks.on("ace-qol.npcDeath", async ({ tokenDoc } = {}) => {
      try { await tokenDoc?.unsetFlag?.(MODULE_ID, FLAG_PREV); } catch (_) {}
    });

    console.log(`${LOG} | online — art from ${PRONE_ART_PATH}`);
  }
}
