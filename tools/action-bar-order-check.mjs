// ─── The Action Bar's insert-and-shift order, tested against the real file ────
//
// ⚠️ WHY THIS EXISTS. On 2026-08-23 the drop logic was written with the textbook
// list-reorder adjustment: when the item came from the left of its destination,
// decrement the destination, because removing it shifted everything down by one.
//
// That is correct for "insert BEFORE that item" and wrong for the rule Johnny
// actually gave: "the item you drop takes the exact slot you dropped it on."
// With the adjustment, dragging slot 2 onto slot 5 quietly landed it in slot 4.
// Reading the code did not catch it. Running it did, on the first try.
//
// ⚠️ THE LOGIC IS LIFTED OUT OF action-bar.mjs, NEVER RETYPED HERE. A test that
// carries its own copy of the maths passes forever while the shipped code rots.
// If the extraction below stops finding the function, that is a failure, not a
// skip — a check that silently tests nothing is worse than no check at all.
//
// Run:  node tools/action-bar-order-check.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "scripts", "action-bar.mjs");
const src = fs.readFileSync(SRC, "utf8");

// Pull the body of _placeAt from the ids line down to the splice that inserts.
const start = src.indexOf("const ids = ActionBar._orderedFor(actor).map(i => i.id);");
const end = src.indexOf("ids.splice(to, 0, item.id);", start);
if (start < 0 || end < 0) {
  console.error("FAIL — could not find the ordering logic in action-bar.mjs.");
  console.error("       The function was renamed or restructured. Fix this extractor;");
  console.error("       do not delete it, or the maths goes untested.");
  process.exit(1);
}
const body = src.slice(start, end + "ids.splice(to, 0, item.id);".length)
  // The only substitutions: feed it a plain array and a plain id instead of a
  // live Foundry actor and Item. The index maths itself is untouched.
  .replace("const ids = ActionBar._orderedFor(actor).map(i => i.id);", "ids = [...ids];")
  .replaceAll("item.id", "id");

const placeAt = new Function("ids", "id", "index", `${body}\nreturn ids;`);

const show = a => a.map((x, i) => `${i + 1}:${x}`).join("  ");
let ok = true;
function check(label, got, want) {
  const pass = got.join(",") === want.join(",");
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  console.log(`        got  ${show(got)}`);
  if (!pass) console.log(`        want ${show(want)}`);
}

const five = ["a", "b", "c", "d", "e"];

// Johnny's own example, 2026-08-23: "If I want to put that in the very first
// slot, it just should push everything else down to the right."
check("a new item onto slot 1 pushes everything right",
  placeAt(five, "NEW", 0), ["NEW", "a", "b", "c", "d", "e"]);

// Gapless: the top row fills before the bottom, so a drop past the end of the
// list lands on the end of the list, never leaving a hole behind it.
check("dropping on empty slot 15 with five actions lands at slot 6",
  placeAt(five, "NEW", 14), ["a", "b", "c", "d", "e", "NEW"]);

check("moving slot 5 to slot 2",
  placeAt(five, "e", 1), ["a", "e", "b", "c", "d"]);

// ⚠️ THE ONE THAT WAS BROKEN. Slot 2 dropped on slot 5 must END on slot 5.
check("moving slot 2 to slot 5 lands ON slot 5",
  placeAt(five, "b", 4), ["a", "c", "d", "e", "b"]);

check("dropping an item back on its own slot changes nothing",
  placeAt(five, "c", 2), five);

// The row boundary: slot 10 is the last of the top row, slot 11 the first of
// the bottom one, so a push at slot 10 has to wrap down rather than fall off.
const twenty = Array.from({ length: 20 }, (_, i) => `i${i + 1}`);
const wrapped = placeAt(twenty, "NEW", 9);
check("a drop on slot 10 pushes the old occupant down into slot 11",
  wrapped.slice(8, 12), ["i9", "NEW", "i10", "i11"]);

// Overflow is not drawn, but it is not forgotten either: make room and it
// comes back. Johnny, 2026-08-23: "it's still obviously on the sheet."
const drawn = wrapped.slice(0, 20);
const off = wrapped.slice(20);
check("the twenty-first is pushed off the bar, not out of the record",
  [String(drawn.length), ...off], ["20", "i20"]);

console.log(`\n${ok ? "ALL PASS — the order behaves as Johnny specified it." : "FAILURES ABOVE"}`);
process.exit(ok ? 0 : 1);
