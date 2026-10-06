# World scripts — run once, at the table

These are not module code. They are console scripts for Johnny's own world, kept
here so they are committed and backed up instead of sitting loose in `Data/`,
where a reinstall would take them.

Each one is run the same way, from the browser console with the world open:

```js
(async () => { const r = await fetch(`/modules/ace-qol/tools/world/NAME.js?v=${Date.now()}`); eval(await r.text()); })();
```

Every one of them is GM-only, prints what it did, and reads the result back out
of the world before it claims anything.

| Script | What it does |
|---|---|
| `ace-portals.js` | Creates the three vortex actors in the Actor folder `1. MONSTERS`: vehicles, 500/500, AC 18, both thresholds empty, 25-foot tokens, unlinked, locked, blue and yellow friendly, red hostile. Creates no table, macro or folder. Reads all three back and prints FOUND or MISSING. |
| `ace-portals-engine.js` | The portal engine itself: the round, the spawn, the thresholds, the cards. Not run directly. `Portal Round` and `Portal Opening` each carry a copy of this text, and `ace-portals-fix.js` is what puts a new copy into them. |
| `ace-portals-fix.js` | Pushes the current engine into both macros in place, repaints the three vortex tokens, and fixes the live session. Creates nothing. Run this after any edit to the engine. |
| `ace-fill-spells.js` | Reads Spellcasting and Innate Spellcasting off every actor a token on a scene is using, unlinked ones included, and adds the spells those words name. Never a player character, never a duplicate, never a removal. |
| `ace-fill-spells-rest.js` | The same job for every actor in the world directory and every unlocked world Actor compendium. It lifts the parser out of `ace-fill-spells.js` at run time rather than carrying a copy, so there is one definition of how a statblock is read. |
| `ace-narration-macros.js` | Updates `Portal Opening` in place and adds `The Temple`: both read through ACE Engine's narrator and use the earthquake the narration panel's own button uses. |
| `ace-dark-gifts.js` | Builds the Amber Temple's twenty dark gifts as supernatural-gift items in an Items folder called `Dark Gifts`, each with its power as real effects and its price as its own effect. |

## What is deliberately not in here

`amber-gifts.json`, the dump of the Amber Temple journal pages, stays in `Data/`
and out of this repo. It is Curse of Strahd's own text, and this repository is
public. `ace-dark-gifts.js` carries my own short paraphrase of each gift, which
is fine; the book's pages are not mine to publish.

A sibling script is fetched by its full path here (`ace-fill-spells-rest.js` asks
for `ace-fill-spells.js`, `ace-portals-fix.js` asks for the engine). If this
folder is ever moved, those two paths move with it.
