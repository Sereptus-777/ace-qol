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

  /** normalised key → [file paths]. Built once, refreshed on demand. */
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
    const cache = new Map();
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

      for (const file of seen) {
        if (!/\.(png|webp|jpe?g|gif|avif)$/i.test(file)) continue;   // no .psd
        const stem = decodeURIComponent(file.split("/").pop().replace(/\.[^.]+$/, ""))
          .replace(/^prone[-_ ]*/i, "");                             // drop the prefix
        const norm = DeathPipeline.normaliseKey(stem);
        const bare = DeathPipeline.stripVariant(norm);
        for (const key of new Set([norm, bare])) {
          if (!key) continue;
          if (!cache.has(key)) cache.set(key, []);
          cache.get(key).push(file);
        }
      }

      // ⚠️ NAME A FILE THAT WILL NEVER MATCH, OUT LOUD. `prrone-jeth.png` (a
      // typo Johnny had, double R) keeps its whole stem as the key, so Jeth can
      // never be found — and silence looks identical to "no art for Jeth".
      const strays = seen
        .filter(f => /\.(png|webp|jpe?g|gif|avif)$/i.test(f))
        .map(f => decodeURIComponent(f.split("/").pop()))
        .filter(n => !/^prone[-_ ]/i.test(n));
      if (strays.length) {
        console.warn(`${LOG} | ${strays.length} file(s) do NOT start with "prone-" and will never match a creature: ${strays.join(", ")}`);
      }

      console.log(`${LOG} | indexed ${seen.length} file(s) → ${cache.size} creature key(s) from ${PRONE_ART_PATH}`);
      if (!seen.length) {
        console.log(`${LOG} | nothing in ${PRONE_ART_PATH} yet — drop images named "Prone-Goblin.png" in there.`);
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

  /* ─── Matching ────────────────────────────────────────────────────────── */

  /**
   * The best prone image for this creature, or null.
   * Tries the creature's own name, then its species/type, exactly like the
   * corpse resolver — a Goblin Boss falls back to a goblin, then a humanoid.
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

    const cache = await this.buildCache();
    if (!cache.size) return null;

    const tries = [];
    /**
     * ⚠️ WALK BACK THROUGH THE NAME, DON'T DEMAND THE WHOLE THING.
     * Johnny names his files by first name — `prone-firaxis.png` — while the
     * actor is "Firaxis Greenbeard". An exact-key lookup asks for
     * `firaxis-greenbeard`, misses, and falls through to nothing, which looks
     * exactly like "I have no art for this creature".
     *
     * So each candidate contributes its full key AND every progressively
     * shorter version: "firaxis-greenbeard" → "firaxis". Longest first, so a
     * specific file always beats a general one — `prone-goblin-boss.png` wins
     * over `prone-goblin.png` for a Goblin Boss.
     */
    const push = (v) => {
      const k = DeathPipeline.normaliseKey(v);
      if (!k) return;
      const parts = k.split("-").filter(Boolean);
      for (let n = parts.length; n >= 1; n--) {
        const key = parts.slice(0, n).join("-");
        tries.push(key, DeathPipeline.stripVariant(key));
      }
    };

    push(actor?.name);
    // A flavour name ("Grish the Unwashed") must not lose the creature — the
    // identity rule keeps the real creature on the actor, so read it too.
    push(actor?.prototypeToken?.name);
    push(actor?.system?.details?.race);
    push(actor?.getFlag?.(MODULE_ID, "creatureBase"));
    const rawType = actor?.system?.details?.type;
    push(typeof rawType === "string" ? rawType : rawType?.subtype);
    push(typeof rawType === "string" ? rawType : rawType?.value);

    for (const key of tries) {
      const hits = cache.get(key);
      if (hits?.length) {
        // Several variants → pick one, so nine goblins are not identical.
        return hits[Math.floor(Math.random() * hits.length)];
      }
    }
    return null;
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
      if (!art) return;                                      // no picture, no swap

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
