// ─── ACE: QOL — Is this a real choice, or the same row twice? ────────────────
//
// ⚠️🔴 WHY THIS FILE EXISTS. Johnny, 2026-09-17: "Thunder Step opens 'Save' and
// 'Save'. That is not a real choice. Do not ask." Two activities, the same type,
// and neither carrying a name of its own, so dnd5e labels both of them with the
// type and the caster is stopped to pick between two identical buttons.
//
// ⚠️ AND THE DANGEROUS HALF IS WHAT MUST STILL ASK. His list, same message:
// Wall of Fire's wall against its ring, Command's five orders, Prismatic Wall's
// wall against its globe, Plane Shift's attack against its save. Every one of
// those is a genuine fork, and three of the four are the SAME TYPE as each
// other - so the rule cannot be "same type means no choice". It is the LABEL
// that separates a fork from a duplicate:
//
//     save/"Create Wall"  save/"Create Ring"     two things. Ask.
//     save/"Approach"     save/"Drop"  ...       five things. Ask.
//     utility/"Create Wall"  utility/"Create Globe"   two things. Ask.
//     attack/""  save/""                          two types. Ask.
//     save/""  save/"Save"                        one thing, twice. Do not ask.
//
// ⚠️ MEASURE A CHOOSER RULE AGAINST THE WHOLE WORLD BEFORE SHIPPING IT. This is
// the third chooser rule I have written for him. The first moved 113 presses and
// trampled Command, Wall of Fire and Plane Shift; the second still moved 15. The
// only one that was right moved exactly the presses he was complaining about.
// `tools/one-real-choice-selftest.mjs` runs this over every item in his world
// and every book on the shelf, and fails if the count moves.
// ──────────────────────────────────────────────────────────────────────────────

/** A label that says nothing the type does not already say. */
function saysNothing(label, type) {
  const name = String(label ?? "").trim().toLowerCase();
  if (!name) return true;                       // dnd5e prints the type for these
  const kind = String(type ?? "").trim().toLowerCase();
  if (!kind) return false;
  if (name === kind) return true;               // "Save" on a save activity
  // "Cast", "Use" and "Activate" are dnd5e's own words for "press the thing",
  // not the name of one of two things. A single one of them beside a blank row
  // of the same type is still one thing twice.
  return ["cast", "use", "activate"].includes(name);
}

/**
 * Are these activities one thing offered twice, rather than a choice?
 *
 * @param {Array} choosable  the activities the dialog would actually offer
 * @returns {{one: boolean, why: string}}
 */
export function oneRealChoice(choosable) {
  const rows = [...(choosable ?? [])];
  if (rows.length < 2) return { one: false, why: "there is no dialog to suppress" };

  const types = new Set(rows.map(a => String(a?.type ?? "").trim().toLowerCase()));
  if (types.size !== 1) {
    return { one: false, why: `they are different kinds of thing (${[...types].join(", ")})` };
  }
  const type = [...types][0];

  const named = rows.filter(a => !saysNothing(a?.name, type));
  if (named.length === 0) {
    return { one: true, why: `every row is just "${type}", so there is nothing to choose between` };
  }
  // ⚠️🔴 ONE NAMED ROW BESIDE A BLANK ONE IS A CHOICE, AND I NEARLY SHIPPED
  // THE OPPOSITE. My first draft said a sheet that labels its real row and
  // leaves the stub blank is a duplicate wearing a hat. The measurement over his
  // world said otherwise, in one run: 448 presses would have stopped asking,
  // and the list was full of things that are plainly two things -
  //
  //     Executioner Greatsword   attack ""  +  attack "Attack (Headtaker)"
  //     Scimitar                 attack ""  +  attack "Attack with Advantage"
  //     Weird                    save ""    +  save "End of Turn Save"
  //     Haste                    utility "" +  utility "Apply Lethargy"
  //
  // Every one of those would have had its press decided for it, and the
  // follow-up would sometimes have won. A row that carries a name carries it
  // because somebody wrote it down. So the moment ANY row says something the
  // type does not, this is a choice and the dialog stands.
  //
  // That is the whole difference between this rule and the two chooser rules
  // before it, which moved 113 and 15 presses respectively and had to be
  // reverted. With this line, the same measurement moves the ones he is
  // complaining about and leaves the rest alone.
  const distinct = new Set(named.map(a => String(a.name).trim().toLowerCase()));
  return { one: false, why: `${named.length === 1 ? "one row is named" : "they are named differently"} `
    + `(${[...distinct].join(", ")})` };
}

/**
 * When the rows are one thing twice, which one actually does the spell?
 *
 * ⚠️🔴 THE SECOND ROW IS NOT A COPY, IT IS A STUB. Johnny, 2026-09-17:
 * "The first does the real spell (teleport + boom at the old square). The second
 * is a 90-foot single-target Con save. That second one is wrong." His Thunder
 * Step is exactly that, and the difference is in the data rather than in the
 * name:
 *
 *   save ""  range self, OVERRIDE  target 10 ft radius on creatures, OVERRIDE
 *   save ""  range inherited       target inherited
 *
 * The first says where it lands. The second says nothing of its own and falls
 * back to the ITEM's range and target, which for that spell is the ninety feet
 * the caster steps to - so pressing it asks for one creature ninety feet away
 * and thunders at them. One row was authored; the other is what an untouched
 * activity looks like.
 *
 * ⚠️ `override: false` MEANS INHERIT, and inheriting is not wrong in itself -
 * that trap is written down from 2026-08-28. It is only a tie-break, and only
 * between rows that are otherwise the same thing twice.
 */
export function pickTheRealOne(choosable) {
  const rows = [...(choosable ?? [])];
  if (rows.length < 2) return rows[0] ?? null;
  const score = (a) => {
    let n = 0;
    const t = a?.target ?? {};
    if (t.override === true) n += 4;                       // it says where it lands
    if (t.template?.type) n += 3;                          // and it declares an area
    if (a?.range?.override === true) n += 1;
    n += (a?.damage?.parts ?? []).length;
    n += (a?.effects ?? []).length;
    return n;
  };
  let best = rows[0], bestScore = score(rows[0]);
  for (const a of rows.slice(1)) {
    const s2 = score(a);
    if (s2 > bestScore) { best = a; bestScore = s2; }
  }
  return best;
}
