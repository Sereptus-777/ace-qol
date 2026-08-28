// ─── The spell says it has an area. Does ACE agree? ─────────────────────────
//
// ⚠️🔴 THE REAL FAILURE BEHIND COLOUR SPRAY WAS NOT A MISSING FEATURE, IT WAS A
// MISSING QUESTION. Colour Spray's sheet declares a 15 foot cone. ACE's entry
// for it said `multi-buff`, which means "no area, pick some creatures". Those
// two statements contradicted each other for months and nothing ever put them
// side by side.
//
// Johnny, 2026-08-28: "It pops a target picker instead. The animation was set to
// play when the cone appears. Well, that's your fucking fault."
//
// ⚠️ AND THE CONTRADICTION IS SILENT BY CONSTRUCTION. A spell that quietly drops
// its area still resolves, still applies its condition, still posts a card. The
// only symptoms are indirect: an animation that never fires, cover and elevation
// with nothing to measure against, and a GM eyeballing who stood in a shape that
// was never drawn. None of those point at the entry.
//
// ⚠️ IT REPORTS, IT NEVER FIXES. Some of these are correct on purpose. Detect
// Magic carries a 30 foot radius and senses outward; drawing a circle nobody is
// affected by is worse than drawing nothing, and `suppressSelfSpellTemplates`
// exists for exactly that. So this names them and lets a human judge, the same
// way the hollow-feature warning does.
const MODULE_ID = "ace-qol";

/** Shapes that actually put a template on the map. */
const DRAWS_AN_AREA = new Set(["template-save", "template-trigger", "template-pool"]);

/**
 * Shapes where discarding a declared area is a deliberate, correct call:
 * the spell radiates from the caster and does nothing to anyone standing in it.
 */
const SENSES_OUTWARD = new Set(["self"]);

/**
 * Every spell whose sheet declares an area that ACE's entry throws away.
 * @returns {Array<{name, declared, size, shape, deliberate}>}
 */
export function findGeometryContradictions() {
  const out = [];
  const seen = new Set();
  try {
    const pipeline = game.aceQol?.SpellPipeline;
    if (!pipeline?._getEntry) return out;

    for (const actor of (game.actors ?? [])) {
      for (const item of (actor.items ?? [])) {
        if (item.type !== "spell" && item.type !== "feat") continue;
        const key = String(item.name ?? "").toLowerCase();
        if (!key || seen.has(key)) continue;

        const declared = item.system?.target?.template?.type;
        if (!declared) continue;              // no geometry to lose

        const entry = pipeline._getEntry(item);
        if (!entry?.shape) continue;          // ACE is not driving this one
        if (DRAWS_AN_AREA.has(entry.shape)) continue;   // they agree

        seen.add(key);
        out.push({
          name: item.name,
          declared,
          size: item.system?.target?.template?.size ?? "?",
          shape: entry.shape,
          // Marked rather than hidden: a human still gets to see the row.
          deliberate: SENSES_OUTWARD.has(entry.shape),
        });
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | could not check for discarded spell areas:`, err);
  }
  return out;
}

/** Say it once, to the GM, at boot. */
export function warnAboutDiscardedAreas() {
  if (!game.user?.isGM) return [];
  const rows = findGeometryContradictions();
  const real = rows.filter(r => !r.deliberate);
  if (!rows.length) return [];

  console.log(`${MODULE_ID} | ${rows.length} spell(s) declare an area that ACE does not draw `
    + `(${real.length} worth a look, ${rows.length - real.length} deliberate):`);
  for (const r of rows) {
    console.log(`${MODULE_ID} |   ${r.name}: its sheet says ${r.declared} ${r.size} feet, `
      + `ACE resolves it as "${r.shape}"`
      + (r.deliberate ? " — deliberate, it senses outward and affects nobody" : ""));
  }

  if (!real.length) return rows;

  const lines = real.map(r => `<li><strong>${foundry.utils.escapeHTML(r.name)}</strong> — `
    + `its sheet declares a ${r.declared} of ${r.size} feet, and ACE resolves it as `
    + `<em>${r.shape}</em>, which draws nothing.</li>`).join("");

  ChatMessage.create({
    whisper: game.users.filter(u => u.isGM).map(u => u.id),
    flags: { [MODULE_ID]: { type: "discardedAreas" } },
    content: `
      <div style="background:#141018;border:2px solid #8a6fc7;border-radius:6px;padding:10px 14px;color:#f0e4c0;">
        <div style="font-family:'Cinzel Decorative','Cinzel',serif;color:#b79bee;font-size:15px;
                    font-weight:700;letter-spacing:1px;margin-bottom:6px;">
          ACE — areas that are never drawn
        </div>
        <p style="margin:4px 0 8px 0;font-size:14px;line-height:1.5;">
          These spells say on their own sheets that they cover an area, and ACE resolves
          them without putting that area on the map. The spell still works, but nothing
          can animate it, and cover, elevation and terrain have no shape to measure.
        </p>
        <ul style="margin:4px 0 8px 18px;font-size:14px;line-height:1.6;">${lines}</ul>
        <p style="margin:8px 0 0 0;font-size:13px;color:#c0b288;font-style:italic;">
          Shown once per load, to GMs only. Nothing has been changed.
        </p>
      </div>`,
  }).catch(err => console.warn(`${MODULE_ID} | discarded-area notice failed to post:`, err));

  return rows;
}

/**
 * ⚠️ `Hooks.once("ready")` FROM INSIDE `ready` NEVER FIRES — every ACE subsystem
 * starts from the entry file's own ready handler, so this would wait on an event
 * already in progress and silently never run.
 */
export function registerGeometryContradictionCheck() {
  const run = () => { try { warnAboutDiscardedAreas(); } catch (err) {
    console.error(`${MODULE_ID} | discarded-area check failed:`, err);
  } };
  if (game.ready) run();
  else Hooks.once("ready", run);
}
