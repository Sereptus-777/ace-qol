// ─── A SECRET SECTION IS STILL THE ITEM'S DESCRIPTION ────────────────────────
//
// ⚠️ WHY. His table, 2026-09-28: the hover on Jeth's Spiked Chain showed one
// sentence, "The Jeth attacks with its Spiked Chain", and nothing else. The item
// carries all of it:
//
//   <section class="secret" id="secret-g8NdvJhrhzHfBj7R">
//     reach 10 ft ... 2d6 + DEX piercing ... DC 14 DEX save ...
//     1-2 Decay 4d10 necrotic / 3-4 Grapple escape DC 14 / 5-6 Topple
//   </section>
//   <p>The [[lookup @name]] attacks with its [[lookup @item.name]].</p>
//
// A D&D Beyond import wraps the whole statblock in a secret section, and
// Foundry's enricher DELETES those unless it is told to keep them. The reader
// asked for `secrets: false` on every call, so for every item shaped like this it
// kept only what sat outside the section. Ten Spiked Chains in hijinx are shaped
// like this, and so is a great deal else that came in the same way.
//
// ⚠️ AND THE FIX HAD A TRAP IN IT. The enriched HTML is cached per item, so if the
// flag were not part of the cache key a GM's hover and a chat card on the same
// client would share one entry: whichever asked first would decide what the other
// got, and the usage card would have carried GM-only text into chat for a player
// to read. Players never see a DC, and a secret section is the likeliest place for
// one to be hiding. So: two keys, and secrets default to OFF everywhere except a
// hover drawn on the reader's own screen.
import { existsSync, mkdtempSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const MODULE = "file:///D:/FoundryVTT/Data/modules/ace-qol";
const WORLD = "D:/FoundryVTT/Data/worlds/hijinx/data";
const LEVELDB = "D:/FoundryVTT/Foundry Virtual Tabletop/resources/app/node_modules/classic-level/index.js";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${String(label).padEnd(62)} ${detail}`);
};

/* ══ the least Foundry this reader needs, with a real enricher ════════════ */
let asked = [];
globalThis.Hooks = { on: () => {}, once: () => {}, callAll: () => {}, call: () => true };
globalThis.CONFIG = { DND5E: { abilities: {} }, Dice: {} };
globalThis.ui = { notifications: { warn: () => {}, error: () => {}, info: () => {} } };
globalThis.game = { ready: true, user: { isGM: true, id: "gm" },
  settings: { get: () => undefined, register: () => {} }, modules: new Map(),
  i18n: { localize: (k) => k, format: (k) => k } };
globalThis.foundry = {
  utils: { getProperty: (o, p) => p.split(".").reduce((x, k) => x?.[k], o) },
  applications: { ux: { TextEditor: { implementation: {
    /**
     * Foundry's own behaviour, in the one respect this file is about: with
     * `secrets: false` every <section class="secret"> is removed; with true it
     * is kept. Recorded so the pins can see what was asked for.
     */
    enrichHTML: async (raw, opts = {}) => {
      asked.push(!!opts.secrets);
      const kept = opts.secrets
        ? String(raw)
        : String(raw).replace(/<section[^>]*class="[^"]*\bsecret\b[^"]*"[^>]*>[\s\S]*?<\/section>/gi, "");
      return kept.replace(/\[\[lookup @name\]\]/g, "Jeth")
                 .replace(/\[\[lookup @item\.name\]\]/g, "Spiked Chain");
    },
  } } } },
};

/* ══ his real Spiked Chain ════════════════════════════════════════════════ */
let CHAIN = null;
if (existsSync(join(WORLD, "actors", "CURRENT")) && existsSync(LEVELDB)) {
  const { ClassicLevel } = await import(pathToFileURL(LEVELDB).href);
  const dst = join(mkdtempSync(join(tmpdir(), "ace-ds-")), "actors");
  cpSync(join(WORLD, "actors"), dst, { recursive: true, filter: (s) => basename(s) !== "LOCK" });
  const db = new ClassicLevel(dst, { valueEncoding: "json" });
  await db.open();
  for await (const [k, v] of db.iterator()) {
    if (k.startsWith("!actors.items!") && /^Spiked Chain/i.test(v?.name ?? "")) { CHAIN = v; break; }
  }
  await db.close();
}
const WORDS = CHAIN?.system?.description?.value
  ?? '<div class="ddb"><section class="secret" id="secret-x"><p>[[/attack extended]], '
   + 'reach 10 ft., one target. <em>Hit:</em> 2d6 piercing. The target must succeed on a '
   + 'DC 14 save or suffer one of the following.</p><p><strong>1\u20132: Decay.</strong> 4d10 '
   + 'necrotic.</p></section><p> The [[lookup @name]] attacks with its [[lookup @item.name]].</p></div>';

console.log(`\nA SECRET SECTION IS STILL THE ITEM'S DESCRIPTION`);
console.log(`  ${CHAIN ? "his own Spiked Chain, read from hijinx" : "the same shape, stood in"}\n`);

const { aceDescriptionHtml, aceDescriptionHtmlSync, acePrimeDescriptions } =
  await import(`${MODULE}/scripts/description-reader.mjs`);

const item = (id) => ({ id, uuid: `Item.${id}`, name: "Spiked Chain", type: "feat",
  system: { description: { value: WORDS } }, getRollData: () => ({}) });

/* ══ 1. WHAT THE ITEM ACTUALLY SAYS ══════════════════════════════════════ */
{
  check("the statblock really is inside a secret section",
    /<section[^>]*\bsecret\b/i.test(WORDS) && /reach 10/i.test(WORDS),
    "reach, damage and the save are all in there");
  const outside = WORDS.replace(/<section[^>]*class="[^"]*\bsecret\b[^"]*"[^>]*>[\s\S]*?<\/section>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  check("and only one sentence sits outside it", !/reach 10/i.test(outside),
    `"${outside.slice(0, 60)}"`);
}

/* ══ 2. THE READER, BOTH WAYS ════════════════════════════════════════════ */
{
  asked = [];
  const open = await aceDescriptionHtml(item("a1"), { secrets: false });
  check("asked for no secrets, the reach is gone, as Foundry intends",
    !/reach 10/i.test(open) && asked[0] === false, "this is what a card gets");

  asked = [];
  const gm = await aceDescriptionHtml(item("a2"), { secrets: true });
  check("asked for secrets, his hover gets the whole statblock",
    /reach 10/i.test(gm) && /DC 14/i.test(gm) && asked[0] === true,
    "reach, the save and the effects are all there");

  check("and the enrichers still resolve, so no brackets reach the screen",
    /Jeth/.test(gm) && !/\[\[lookup/.test(gm), "the name and the item name are filled in");
}

/* ══ 3. THE TRAP: ONE CACHE, TWO ANSWERS ═════════════════════════════════ */
{
  // ⚠️ THE SAME ITEM, ON ONE CLIENT, ASKED BOTH WAYS. If the key ignored the
  // flag, the second read would be served the first one's answer and the usage
  // card would have posted GM-only text for a player to read.
  const one = item("shared");
  const gmFirst = await aceDescriptionHtml(one, { secrets: true });
  const cardAfter = await aceDescriptionHtml(one, { secrets: false });
  check("a card asking after a GM hover does NOT get the GM's copy",
    /reach 10/i.test(gmFirst) && !/reach 10/i.test(cardAfter),
    "two keys, two answers");

  const two = item("shared2");
  const cardFirst = await aceDescriptionHtml(two, { secrets: false });
  const gmAfter = await aceDescriptionHtml(two, { secrets: true });
  check("and a GM hovering after a card is not given the thin one",
    !/reach 10/i.test(cardFirst) && /reach 10/i.test(gmAfter), "both directions");
}

/* ══ 4. THE DEFAULT IS THE SAFE ONE ══════════════════════════════════════ */
{
  asked = [];
  await aceDescriptionHtml(item("d1"));
  check("called with no options at all, secrets stay OFF",
    asked[0] === false, "a caller that has not thought about it cannot leak");
}

/* ══ 5. AND THE SYNC READ, WHICH IS WHAT A HOVER ACTUALLY CALLS ══════════ */
{
  const h = item("sync1");
  check("cold, the sync read says 'not yet' rather than guessing",
    aceDescriptionHtmlSync(h, { secrets: true }) === "", "empty means not warm");
  // Warm it the way the action bar does, then ask again.
  acePrimeDescriptions([h]);
  await new Promise(r => setTimeout(r, 30));
  const warm = aceDescriptionHtmlSync(h, { secrets: true });
  check("primed on a GM's client, the sync read has the statblock",
    /reach 10/i.test(warm), warm ? "warm and complete" : "still cold");
  check("and the open copy is warmed too, for a card that asks later",
    /Spiked Chain/.test(aceDescriptionHtmlSync(h, { secrets: false }) || " ")
    && !/reach 10/i.test(aceDescriptionHtmlSync(h, { secrets: false }) || ""),
    "both keys are warm");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.stdout.write("", () => process.exit(fail ? 1 : 0));
