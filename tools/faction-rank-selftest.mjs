// ═══════════════════════════════════════════════════════════════════════════
//  FACTION RANK SELF-TEST — a creature is offered what it looks like it joins
// ───────────────────────────────────────────────────────────────────────────
//  His table, 2026-09-24, on a lawful good young gold dragon that was offered
//  exactly one faction: "Oh, look, we got young gold dragon. It's gold, and
//  it's a dragon, and it's lawful good. How many factions can we pick off the
//  top of my head that it could belong to? Why isn't it working like that?"
//
//  It was not working like that because the scorer asked a category table
//  whether a "dragon" gets along with a "religious" organisation, and never
//  read the sentence in his own world that says "a dragon faction aligned with
//  good". The kinship pass reads exactly that.
//
//  ⚠️ THE REAL FUNCTIONS, out of the module. A test that restates the rules
//  passes forever and proves nothing.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs";

const SRC = "D:/FoundryVTT/Data/modules/ace-engine/scripts/npc/faction-registry.mjs";
const src = readFileSync(SRC, "utf8");
const code = src.slice(src.indexOf("function _factionWords("),
                       src.indexOf("// ═══ HOW MANY OF THEM ARE THERE"));
if (!code.includes("kinshipScore")) {
    console.error("faction-rank: the kinship pass is not where this test expects it in faction-registry.mjs");
    process.exit(1);
}
const { kinshipScore, creatureWords } =
    new Function(code + "\nreturn { kinshipScore, creatureWords };")();

let passed = 0, failed = 0;
const check = (what, ok, detail = "") => {
    if (ok) { passed++; console.log(`  ok   ${what}`); }
    else { failed++; console.log(`  FAIL ${what}${detail ? `  ${detail}` : ""}`); }
};

const mk = (name, value, subtype, alignment) => ({
    name, system: { details: { alignment, type: { value, subtype } } },
});

/** Rank a set of factions for one creature, the way the dialog does. */
function rank(actor, base, species, factions) {
    const words = creatureWords(actor, base, species);
    const al = actor.system.details.alignment;
    return factions
        .map(f => ({ name: f.name, ...kinshipScore(f, words, al) }))
        .sort((a, b) => b.bonus - a.bonus);
}

console.log("\nFACTION RANK: WHAT A CREATURE LOOKS LIKE IT JOINS");

// ── The gold dragon, which is the case he reported ───────────────────────
{
    const aryel = mk("Aryel (Young Gold Dragon)", "dragon", "metallic", "Lawful Good");
    const world = [
        { name: "metallic dragons", type: "religious",
          description: "A dragon faction aligned with good, dedicated to protecting innocent creatures and maintaining justice." },
        { name: "red dragons", type: "tribal",
          description: "Chromatic dragons who hoard and burn. Red dragons rule by fear." },
        { name: "Order of the Silver Dragon", type: "knightly_order",
          description: "A knightly order sworn to protect the innocent, named for the silver dragon that founded it." },
        { name: "Saerloon Banking Consortium", type: "mercantile",
          description: "Banking houses controlling the flow of currency." },
        { name: "Cult of the Dragon", type: "cult", alignment: "Chaotic Evil",
          description: "Fanatics who raise dragons as dracoliches." },
    ];
    const r = rank(aryel, "dragon", "gold dragon", world);
    const order = r.map(x => x.name);

    check("a faction of good dragons outranks everything else his world holds",
        order[0] === "metallic dragons", `got ${order[0]}`);
    check("an order named after a dragon is still a home for one",
        order.indexOf("Order of the Silver Dragon") < order.indexOf("Saerloon Banking Consortium"));
    check("a faction made of RED dragons is not kin to a gold, even though both are dragons",
        order.indexOf("red dragons") > order.indexOf("Order of the Silver Dragon"),
        `order: ${order.join(" > ")}`);
    check("and an evil cult ranks below a lawful good creature's own kind, without being hidden",
        order.indexOf("Cult of the Dragon") > 0
          && r.find(x => x.name === "Cult of the Dragon").reasons.includes("opposed"));
    check("the reason is written down, so a wrong ranking is visible rather than mysterious",
        r[0].reasons.some(w => w.includes("dragon")));
}

// ── The same rules on creatures that are not dragons ─────────────────────
{
    const goblin = mk("Goblin", "humanoid", "goblinoid", "Neutral Evil");
    const world = [
        { name: "Maglubiyet's Army", type: "cult", description: "Goblinoids who serve the god of goblins in war." },
        { name: "Lords of Waterdeep", type: "political", description: "The masked rulers of the city." },
        { name: "Order of the Gauntlet", type: "knightly_order", alignment: "Lawful Good",
          description: "The faithful who hunt evil wherever it hides." },
    ];
    const order = rank(goblin, "goblin", "goblinoid", world).map(x => x.name);
    check("a goblin is offered the goblin god's army first",
        order[0] === "Maglubiyet's Army", `got ${order[0]}`);
    check("and the lawful good order it would never join ranks last, still listed",
        order[order.length - 1] === "Order of the Gauntlet", `got ${order.join(" > ")}`);
}

// ── Alignment read from the words when the field is empty ────────────────
{
    const paladin = mk("Aryel", "dragon", "metallic", "Lawful Good");
    const world = [
        { name: "Evil Lizardfolk", type: "cult", description: "Lizardfolk corrupted by black dragons, devoted servants of evil." },
        { name: "Dragon Watch", type: "military", description: "Wardens who watch the dragons of the north." },
    ];
    const r = rank(paladin, "dragon", "gold dragon", world);
    check("a faction that says it is evil in its own name is treated as evil, field or no field",
        r.find(x => x.name === "Evil Lizardfolk").reasons.includes("opposed"));
    check("so the neutral one outranks it for a lawful good creature",
        r[0].name === "Dragon Watch", `got ${r[0].name}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
