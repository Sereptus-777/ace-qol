// ─── A broken icon should never reach the table ──────────────────────────────
//
// ⚠️ WHY THIS EXISTS. Johnny, 2026-08-23, looking at a goblin's sheet: the
// Features, Actions and Reactions rows showed no icons at all, just the first
// few letters of each name where a picture should be — "Kick", "Quick",
// "Gobli", "Scatt". That is a browser drawing ALT TEXT for an image that 404ed.
//
// "I wanna be able to fix that, even if it's not our fucking fault and not our
// code. I wanna be able to fix that so that never happens again either."
//
// He is right to want it regardless of blame. An imported statblock, a token
// pack, a module uninstalled after its items were copied onto an actor — any of
// those leaves an item pointing at a picture that is no longer there. The item
// still works. It just looks broken, on the sheet, in chat cards, on the
// hotbar, everywhere, forever, and it makes a paid product look unfinished in
// front of a table.
//
// TWO LAYERS, on purpose:
//
//   1. DISPLAY — a broken icon is swapped for the correct default the instant
//      the browser reports it cannot load. Writes nothing, works on items ACE
//      does not own, and covers the case where the file might come back later.
//
//   2. DATA — an explicit repair that finds every item whose image does not
//      resolve and writes the proper default in. Permanent, and fixes chat
//      cards and the hotbar too, not just the sheet.
//
// ⚠️ THE DEFAULT COMES FROM THE SYSTEM, NOT FROM ME. dnd5e publishes a
// per-item-type default artwork table and its own resolver. Inventing a second
// opinion about what a "feat" should look like would drift from the system the
// first time it changed. We read its table; we do not call its logic.
//
// ⚠️ REPORT BEFORE WRITING. The data pass reports what it found and changes
// nothing unless asked. A sweep that silently rewrites hundreds of items in
// somebody's world is not a repair, it is damage with good intentions.
const MODULE_ID = "ace-qol";
const TAG = "ace-qol | IconRepair";

const FALLBACK = "icons/svg/item-bag.svg";

/** The system's own default picture for an item of this type. */
function defaultIconFor(type) {
    try {
        const art = CONFIG?.Item?.documentClass?.getDefaultArtwork?.({ type })
            ?? globalThis.Item?.implementation?.getDefaultArtwork?.({ type });
        if (art?.img) return art.img;
    } catch (_) { /* fall through to the table, then the constant */ }
    try {
        const fromTable = CONFIG?.DND5E?.defaultArtwork?.Item?.[type];
        if (fromTable) return fromTable;
    } catch (_) { /* fall through */ }
    return FALLBACK;
}

// ─── Layer 1: display ────────────────────────────────────────────────────────

/**
 * Swap a broken picture for the right default, in the DOM only.
 *
 * ⚠️ IT LISTENS FOR THE BROWSER'S OWN VERDICT rather than testing paths itself.
 * The browser is the only thing that actually knows whether a picture loaded,
 * and asking it costs nothing: no extra requests, no guessing about which paths
 * are valid, and it is right about files served from anywhere.
 */
function healImagesIn(root) {
    if (!root?.querySelectorAll) return 0;
    let watched = 0;
    for (const img of root.querySelectorAll("img")) {
        if (img.dataset.aceIconWatched) continue;
        img.dataset.aceIconWatched = "1";
        watched++;

        const heal = () => {
            // Guard against a default that is itself missing, which would loop.
            if (img.dataset.aceIconHealed) return;
            img.dataset.aceIconHealed = "1";
            const type = img.closest("[data-item-id]")?.dataset?.itemType
                ?? img.dataset.itemType ?? "";
            const replacement = defaultIconFor(type);
            if (img.getAttribute("src") === replacement) return;
            console.debug(`${TAG} | broken icon "${img.getAttribute("src")}" replaced on screen with ${replacement}`);
            img.src = replacement;
        };

        // An image that has ALREADY failed by the time we get here fires no
        // further event — complete with zero natural width is the only way to
        // tell, and missing it is how a sheet that rendered before us keeps its
        // broken icons forever.
        if (img.complete && img.naturalWidth === 0 && img.getAttribute("src")) heal();
        else img.addEventListener("error", heal, { once: true });
    }
    return watched;
}

// ─── Layer 2: data ───────────────────────────────────────────────────────────

/** Does this picture actually exist? One HEAD request, no body downloaded. */
async function exists(path) {
    if (!path) return false;
    // A data: or bare SVG from Foundry's own set is always fine.
    if (path.startsWith("data:")) return true;
    try {
        const res = await fetch(foundry.utils.getRoute(path), { method: "HEAD" });
        return res.ok;
    } catch (_) {
        return false;
    }
}

async function batched(items, concurrency, fn) {
    for (let i = 0; i < items.length; i += concurrency) {
        await Promise.all(items.slice(i, i + concurrency).map(fn));
    }
}

/**
 * Find every item whose picture does not resolve, and optionally repair it.
 *
 * @param {object} [opts]
 * @param {Actor}  [opts.actor] limit to one creature; omit to sweep the world
 * @param {boolean}[opts.fix=false] write the repairs
 */
export async function repairItemIcons({ actor = null, fix = false } = {}) {
    if (!game.user?.isGM) {
        ui.notifications?.warn("Only the GM can repair item icons.");
        return { checked: 0, broken: 0, rows: [] };
    }

    const actors = actor ? [actor] : [...(game.actors ?? [])];
    const rows = [];
    const seen = new Map();       // path -> ok, so a shared icon is asked about once

    const check = async (path) => {
        if (seen.has(path)) return seen.get(path);
        const ok = await exists(path);
        seen.set(path, ok);
        return ok;
    };

    let checked = 0;
    for (const a of actors) {
        const items = [...(a.items ?? [])];
        await batched(items, 8, async (item) => {
            const img = item.img ?? "";
            checked++;
            if (!img) {
                rows.push({ actor: a, item, img: "(none)", type: item.type, fixTo: defaultIconFor(item.type) });
                return;
            }
            if (await check(img)) return;
            rows.push({ actor: a, item, img, type: item.type, fixTo: defaultIconFor(item.type) });
        });
    }

    console.log(`${TAG} | ${checked} item picture(s) checked across ${actors.length} creature(s).`);
    if (!rows.length) {
        console.log(`${TAG} | Every one of them loads. Nothing to repair.`);
        if (!actor) ui.notifications?.info("ACE: every item icon in this world loads correctly.");
        return { checked, broken: 0, rows: [] };
    }

    console.log(`${TAG} | ${rows.length} item(s) point at a picture that is not there:`);
    const byPath = new Map();
    for (const r of rows) {
        if (!byPath.has(r.img)) byPath.set(r.img, []);
        byPath.get(r.img).push(r);
    }
    for (const [path, group] of byPath) {
        console.log(`   ${path}`);
        console.log(`      ${group.length} item(s), e.g. "${group[0].item.name}" on ${group[0].actor.name}`);
    }

    if (!fix) {
        console.log(`${TAG} | Nothing was changed. Run again with { fix: true } to write the defaults in.`);
        ui.notifications?.warn(`ACE: ${rows.length} item icon(s) are broken. See the console (F12); nothing was changed.`);
        return { checked, broken: rows.length, rows };
    }

    // ⚠️ ONE UPDATE PER ACTOR, not one per item. A world with hundreds of
    // broken icons would otherwise fire hundreds of document writes, each one
    // broadcast to every connected client.
    const byActor = new Map();
    for (const r of rows) {
        if (!byActor.has(r.actor)) byActor.set(r.actor, []);
        byActor.get(r.actor).push({ _id: r.item.id, img: r.fixTo });
    }
    let repaired = 0;
    for (const [a, updates] of byActor) {
        try {
            await a.updateEmbeddedDocuments("Item", updates);
            repaired += updates.length;
        } catch (err) {
            console.warn(`${TAG} | Could not repair icons on ${a.name}:`, err);
        }
    }
    console.log(`${TAG} | ${repaired} item icon(s) repaired.`);
    ui.notifications?.info(`ACE: repaired ${repaired} broken item icon(s).`);
    return { checked, broken: rows.length, repaired, rows };
}

export function installIconRepair() {
    // ⚠️ BOTH RENDER HOOKS, AND A SWEEP OF WHAT IS ALREADY OPEN. V13 fires the
    // V1 and V2 hooks for different sheets, and a sheet that was on screen
    // before this registered would otherwise keep its broken icons for the
    // whole session — the same defect that once left chat cards undecorated.
    const onRender = (_app, html) => {
        try { healImagesIn(html?.[0] ?? html); }
        catch (err) { console.debug(`${TAG} | icon heal failed (non-fatal):`, err); }
    };
    Hooks.on("renderActorSheet", onRender);
    Hooks.on("renderActorSheetV2", onRender);
    Hooks.on("renderItemSheet", onRender);
    Hooks.on("renderItemSheetV2", onRender);

    const sweepOpen = () => {
        try {
            for (const app of Object.values(ui.windows ?? {})) {
                if (app?.element) healImagesIn(app.element?.[0] ?? app.element);
            }
            for (const el of document.querySelectorAll(".application, .sheet")) healImagesIn(el);
        } catch (err) { console.debug(`${TAG} | initial icon sweep failed (non-fatal):`, err); }
    };

    // ⚠️ ready-inside-ready never fires. Run now if the world is already up.
    if (game.ready) sweepOpen();
    else Hooks.once("ready", sweepOpen);

    console.log(`${TAG} | Broken item icons will be replaced on screen. `
        + `Run game.aceQol.repairItemIcons() to find and fix them permanently.`);
}
