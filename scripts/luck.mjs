// ─── ACE QOL — Luck: the Lucky feat (2014 and 2024) and the halfling's Lucky ──
//
// Johnny, 2026-09-18. His rules, in his words where they are short:
//
// HALFLING LUCKY (a species trait, never the feat). "When a Halfling rolls a 1
// on an attack, check, or save: reroll that d20, must use the new roll. No box.
// No luck point." dnd5e already does this on its own rolls when the creature
// carries its halfling flag (Perrin's 2024 "Luck" sets it through an effect).
// Chudd's 2014 "Lucky" trait sets nothing, so dnd5e never rerolled a 1 for
// him, and ACE rolls a good many d20s itself (saves, contests, repeat saves,
// spell attacks), so none of those rerolled a 1 for anybody.
//
// THE LUCKY FEAT. "Match by the suite feat key only. Do not match Halfling
// Lucky or any other name that contains 'lucky'." The key is `spellKey`, the
// one name key in the suite, and the item must be a feat: Chudd carries the
// 2024 feat AND a 2014 halfling trait that is also named "Lucky".
//
//   2014: 3 luck points, back on a long rest.
//     • After their own attack, check or save dice have stopped and BEFORE the
//       result is applied, ask only if that roll is about to FAIL. Yes: spend
//       1, roll another d20, they pick which d20 to keep.
//     • When an attack is rolled against them, ask only if it is about to HIT.
//       Yes: spend 1, they roll a d20, they choose the attacker's die or theirs.
//     • Never on a hit already made or a save already passed.
//     • Two luck spends on the same roll cancel. No extra dice.
//   2024: luck points equal the proficiency bonus, back on a long rest.
//     • NO box on every attack they make. A Lucky button on THEIR roll card:
//       pressed before the roll, it spends 1 and gives Advantage.
//     • When an attack is rolled against them, one box before the attacker's
//       roll is locked: spend 1 to give that attack Disadvantage?
//   Both: the box or button goes to the token's owner (connected: theirs alone;
//   offline or no owner: the GM), no card before Dice So Nice finishes, and a
//   console line whenever a holder is skipped, with the reason.
//
// ⚠️ THE BOXES GO THROUGH THE ONE REACTION DOOR (ReactionEngine._promptReaction),
// so they are routed, announced to the silence watch, dinged and counted as a
// no if they never appear, exactly like Shield and Counterspell.
//
// ⚠️ THE CLIENT THAT SAYS YES SPENDS THE POINT. A player's screen cannot write
// an NPC's item and the GM's can write anything, so the door's answering side
// spends it (reaction-engine, "showReactionPrompt") and says so in its answer.
//
// ⚠️ IMPORTS ONLY LEAF FILES. The reaction engine is read from game.aceQol at
// the moment it is needed, never imported, so this file cannot start a cycle.
// ──────────────────────────────────────────────────────────────────────────────

import { spellKey } from "./rules/spell-name.mjs";
import { whoAnswers } from "./who-answers.mjs";
import { safeShowForRoll, awaitDiceSettle, awaitArmedDicePeek } from "./dsn-utils.mjs";
import { judgeAttack, isAHit, missADieCouldChange } from "./rules/attack-hit.mjs";
import { naturalD20 } from "./rolldata-utils.mjs";

const MODULE_ID = "ace-qol";
const LOG = `${MODULE_ID} | Luck`;
const say = (msg) => console.log(`${LOG} | ${msg}`);

/** Lucky's colour on the boxes and cards: a clover green. */
export const LUCK_GREEN = "#3fa34d";

/* ═══ WHO HAS IT ═══════════════════════════════════════════════════════════ */

/**
 * The Lucky feat on this creature, or null.
 *
 * ⚠️ A FEAT, NOT A SPECIES TRAIT. The 2014 halfling trait is literally named
 * "Lucky" too; dnd5e types it "race". A feat item left untyped still counts.
 */
export function luckyFeatItem(actor) {
  for (const it of actor?.items ?? []) {
    if (it?.type !== "feat") continue;
    const kind = String(it.system?.type?.value ?? "");
    if (kind && kind !== "feat") continue;
    if (spellKey(it.name) === "lucky") return it;
  }
  return null;
}

/** "2014" or "2024" for this copy of the feat: the item's own rules first. */
export function featEdition(item) {
  const src = String(item?.system?.source?.rules ?? "");
  if (src === "2014" || src === "2024") return src;
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; }
  catch (_) { return "2024"; }
}

/** Luck points left and the most there can be, read from dnd5e's uses. Null when the item has none. */
export function luckPoints(item) {
  const u = item?.system?.uses ?? {};
  const max = Number(u.max);
  if (!Number.isFinite(max) || max <= 0) return null;
  const value = Number(u.value);
  const left = Number.isFinite(value) ? value : Math.max(0, max - (Number(u.spent) || 0));
  return { left, max };
}

/**
 * Everything about this creature's Lucky feat, or null when it has none.
 * @returns {{item, edition: "2014"|"2024", left: number, max: number}|{item, edition, missingUses: true}|null}
 */
export function luckyFeat(actor) {
  const item = luckyFeatItem(actor);
  if (!item) return null;
  const edition = featEdition(item);
  const pts = luckPoints(item);
  if (!pts) return { item, edition, missingUses: true, left: 0, max: 0 };
  return { item, edition, left: pts.left, max: pts.max };
}

/** The halfling trait item ("Lucky" in 2014, "Luck" in 2024), or null. Never the feat. */
export function halflingTraitItem(actor) {
  for (const it of actor?.items ?? []) {
    if (it?.type !== "feat") continue;
    if (String(it.system?.type?.value ?? "") !== "race") continue;
    const key = spellKey(it.name);
    if (key === "lucky" || key === "luck" || key === "halfling luck" || key === "halfling lucky") return it;
  }
  return null;
}

/** Does this creature reroll a natural 1 on its d20 tests? */
export function hasHalflingLuck(actor) {
  if (!actor) return false;
  try { if (actor.getFlag?.("dnd5e", "halflingLucky")) return true; } catch (_) { /* no flags is no luck */ }
  return !!halflingTraitItem(actor);
}

function nameOf(actor) { return actor?.token?.name ?? actor?.name ?? "a creature"; }

/**
 * Should this creature's skip be written down? Only when it holds the feat or
 * a luck-named trait: a line for every roll of every goblin would bury the ones
 * that matter.
 */
function holdsAnyLuck(actor) {
  return !!(luckyFeatItem(actor) || halflingTraitItem(actor));
}

/** A line for the log saying why a creature with some kind of luck was not asked. */
function skip(actor, why) {
  if (holdsAnyLuck(actor)) say(`${nameOf(actor)}: no Lucky box, ${why}.`);
}

/* ═══ HALFLING LUCKY ═══════════════════════════════════════════════════════ */

/**
 * The d20 of a formula ACE builds itself, with the halfling's reroll on a 1.
 * "1d20 + 5" → "1d20r1=1 + 5"; "2d20kh + 5" → "2d20r1=1kh + 5". It is dnd5e's
 * own modifier (reroll once, on a 1), so a kept die reads exactly as dnd5e's do.
 */
export function withHalflingLuck(formula, actor) {
  const f = String(formula ?? "");
  if (!hasHalflingLuck(actor)) return f;
  if (/d20r1=1/.test(f)) return f;
  return f.replace(/^(\s*\d*)d20/, "$1d20r1=1");
}

/** Did this roll's d20 come up 1 and get rerolled? For the log and the card. */
export function halflingRerolled(roll) {
  try {
    const die = (roll?.dice ?? []).find(d => Number(d?.faces) === 20);
    return !!die?.results?.some?.(r => r?.rerolled && Number(r.result) === 1);
  } catch (_) { return false; }
}

/* ═══ SPENDING ═════════════════════════════════════════════════════════════ */

/** Spend one luck point on the feat item. Returns true once it is written. */
export async function spendLuck(item) {
  try {
    if (!item) return false;
    const spent = Number(item.system?.uses?.spent) || 0;
    await item.update({ "system.uses.spent": spent + 1 });
    const pts = luckPoints(item);
    say(`${nameOf(item.actor)} spent a luck point (${pts ? `${pts.left} of ${pts.max} left` : "left unknown"}).`);
    return true;
  } catch (err) {
    console.warn(`${LOG} | could not spend ${nameOf(item?.actor)}'s luck point:`, err);
    return false;
  }
}

/** The same, from a uuid, on the screen that answered yes (see the reaction door). */
export async function spendLuckByUuid(uuid) {
  try {
    const item = uuid ? await fromUuid(uuid) : null;
    if (!item || spellKey(item.name) !== "lucky") {
      console.warn(`${LOG} | asked to spend luck on "${uuid}", which is not a Lucky feat. Nothing spent.`);
      return false;
    }
    return spendLuck(item);
  } catch (err) {
    console.warn(`${LOG} | could not spend luck on ${uuid}:`, err);
    return false;
  }
}

/* ═══ THE DOOR ═════════════════════════════════════════════════════════════ */

function door() {
  const eng = game.aceQol?.reactionEngine;
  if (!eng?._promptReaction) {
    console.warn(`${LOG} | the reaction engine is not on the API, so no Lucky box can open.`);
    return null;
  }
  return eng;
}

/** "Spend a luck point?" Returns { yes, spentAlready }. */
async function askSpend(opts) {
  const eng = door();
  if (!eng) return { yes: false, spentAlready: false };
  const who = whoAnswers(opts.reactorActor);
  say(`asking ${who.user?.name ?? "this screen"} for ${nameOf(opts.reactorActor)}: ${who.why}.`);
  const res = await eng._promptReaction({
    type: "lucky", title: "Lucky", heading: "Lucky",
    icon: "fa-clover", accentColor: LUCK_GREEN,
    ...opts,
    luckItemUuid: opts.luckItemUuid,
  });
  return { yes: !!res?.accepted, spentAlready: !!res?.choiceData?.luckSpent };
}

/** "Which d20?" Returns the chosen id, or null when the box was closed. */
async function askChoice(opts) {
  const eng = door();
  if (!eng) return null;
  const res = await eng._promptReaction({
    type: "luckyChoice", title: "Lucky", heading: "Lucky: which d20?",
    icon: "fa-clover", accentColor: LUCK_GREEN,
    ...opts,
  });
  return res?.accepted ? (res.choiceData?.choice ?? null) : null;
}

/** Roll the luck die where everybody sees it, and wait for it to land. */
async function rollLuckDie(actor, label) {
  const roll = await new Roll(withHalflingLuck("1d20", actor)).evaluate();
  safeShowForRoll(roll, `Lucky (${label})`);
  await awaitDiceSettle(15000);
  const face = roll.dice?.[0]?.total ?? roll.total;
  if (halflingRerolled(roll)) say(`${nameOf(actor)}'s luck die came up 1 and was rerolled (halfling luck): ${face}.`);
  return Number(face);
}

/** Wait for the dice the roll itself threw, before anybody is asked. */
async function untilDiceLand(dice) {
  try {
    if (dice === "armed") await awaitArmedDicePeek();
    else if (dice === "ours") await awaitDiceSettle(15000);
  } catch (err) {
    console.warn(`${LOG} | could not wait for the dice before asking (asking anyway):`, err);
  }
}

/* ═══ 2014: A CREATURE'S OWN ROLL ═════════════════════════════════════════ */

/**
 * 2014 Lucky on a creature's own d20 test, after its dice land and before the
 * result is used. Only asks when the roll is about to fail.
 *
 * @param {object} o
 * @param {Actor} o.actor
 * @param {"attack"|"check"|"save"} o.kind
 * @param {string} o.what        e.g. "Dexterity save against Fireball"
 * @param {number[]} o.d20s      every d20 face this roll showed
 * @param {number} o.kept        the face the roll used
 * @param {number} o.total
 * @param {(total:number, d20:number) => {fails:boolean, words:string}} o.judge
 * @param {object} [o.ledger]    { spenders:Set<string>, original:{d20,total} } shared by everyone spending on this roll
 * @param {"armed"|"ours"|"none"} [o.dice]
 * @returns {Promise<{d20:number, total:number, changed:boolean, spent:boolean, cancelled?:boolean, note?:string}>}
 */
export async function ownRoll(o) {
  const { actor, kind, what, kept, total, judge } = o;
  const unchanged = { d20: kept, total, changed: false, spent: false };
  const feat = luckyFeat(actor);
  if (!feat) {
    if (halflingTraitItem(actor)) skip(actor, `its "${halflingTraitItem(actor).name}" is the halfling trait, not the Lucky feat`);
    return unchanged;
  }
  if (feat.edition === "2024") { skip(actor, "2024 Lucky is the button on its own roll card, pressed before the roll"); return unchanged; }
  if (feat.missingUses) { skip(actor, `its Lucky feat has no uses set on the item (set Uses to 3, back on a long rest)`); return unchanged; }
  if (!(feat.left > 0)) { skip(actor, "no luck points left"); return unchanged; }
  const now = judge(total, kept);
  if (!now.fails) { skip(actor, `the ${kind} is already a success (${now.words})`); return unchanged; }

  const ledger = o.ledger ?? { spenders: new Set(), original: { d20: kept, total } };
  const me = actor.uuid ?? actor.id;
  if (ledger.spenders.has(me)) { skip(actor, "it already spent a luck point on this roll"); return unchanged; }
  const cancels = ledger.spenders.size > 0;

  await untilDiceLand(o.dice ?? "none");
  const ask = await askSpend({
    reactorActor: actor, reactorToken: actor.getActiveTokens?.()[0] ?? null,
    luckItemUuid: feat.item.uuid,
    description: cancels
      ? `Your ${what} is about to fail (${now.words}). Another creature already spent a luck point on this roll: if you spend one, the two cancel and the roll stands as first rolled. ${feat.left} of ${feat.max} left.`
      : `Your ${what} is about to fail (${now.words}). Spend a luck point to roll another d20 and keep the one you want? ${feat.left} of ${feat.max} left.`,
    acceptLabel: "Spend a luck point", declineLabel: "Keep the roll",
  });
  if (!ask.yes) { say(`${nameOf(actor)} kept the roll (${what}).`); return unchanged; }
  const paid = ask.spentAlready || await spendLuck(feat.item);
  if (!paid) return unchanged;
  ledger.spenders.add(me);

  if (cancels) {
    say(`${nameOf(actor)} and another creature both spent luck on the same roll: they cancel, no dice, the roll stands as first rolled (${ledger.original.d20}).`);
    return { d20: ledger.original.d20, total: ledger.original.total, changed: true, spent: true, cancelled: true,
      note: `Lucky: two luck points spent on one roll cancel; it stands as first rolled (${ledger.original.d20})` };
  }

  const fresh = await rollLuckDie(actor, what);
  const faces = [...new Set([kept, ...(o.d20s ?? []), fresh].map(Number).filter(Number.isFinite))];
  let face = kept;
  if (faces.length > 1) {
    const choices = faces.map(f => {
      const t = total - kept + f;
      const j = judge(t, f);
      return { id: String(f), label: `Keep ${f}`, sub: `${t}, ${j.words}` };
    });
    const picked = await askChoice({
      reactorActor: actor, reactorToken: actor.getActiveTokens?.()[0] ?? null,
      description: `Your luck die shows ${fresh}. Which d20 does your ${what} use?`,
      choices,
    });
    if (picked == null) say(`${nameOf(actor)} closed the choice without picking, so the roll keeps ${kept}.`);
    else face = Number(picked);
  } else {
    say(`${nameOf(actor)}'s luck die matches the roll (${fresh}), so there is nothing to choose.`);
  }
  const newTotal = total - kept + face;
  say(`${nameOf(actor)} rolled ${fresh} with luck and kept ${face} (${what}: ${total} → ${newTotal}).`);
  return { d20: face, total: newTotal, changed: face !== kept, spent: true,
    note: `Lucky: rolled ${fresh}, kept ${face}${face !== kept ? ` (was ${kept})` : ""}` };
}

/**
 * 2014 Lucky on a d20 test against a DC, in one call, for the many places that
 * decide "total against DC" on their own. A creature without the feat costs
 * nothing: nothing is shown, asked or logged.
 *
 * @param {object} o
 * @param {Actor} o.actor
 * @param {"check"|"save"} o.kind
 * @param {string} o.what           e.g. "Constitution save against Dominate Person (DC 17)"
 * @param {Roll} [o.roll]           the roll, when there is one to read the dice from
 * @param {number} o.total
 * @param {number} [o.d20]          the face it kept, when there is no roll
 * @param {number} o.dc
 * @param {"ours"|"armed"|"none"|"show"} [o.dice]  whose dice to wait for before asking;
 *        "show" throws a roll nobody has seen yet, so the box never asks about dice
 *        the table did not watch land
 * @returns {Promise<{total:number, d20:number|null, spent:boolean, note:string|null}>}
 */
export async function againstDC({ actor, kind, what, roll = null, total, d20 = null, dc, dice = "none" }) {
  const same = { total, d20, spent: false, note: null };
  if (!luckyFeatItem(actor) || !Number.isFinite(Number(dc)) || !Number.isFinite(Number(total))) return same;
  // ⚠️ NOTHING LANDS BEFORE THE DICE (his rule). Shown here, waited for here,
  // so no path out of this call (a box, a skip, a no) can beat them.
  if (dice === "show") {
    if (roll && Number(total) < Number(dc)) {
      safeShowForRoll(roll, `${nameOf(actor)} ${what}`);
      await awaitDiceSettle(15000);
    }
    dice = "none";
  }
  const kept = Number.isFinite(Number(d20)) ? Number(d20) : naturalD20(roll);
  if (!Number.isFinite(Number(kept))) { skip(actor, `the ${kind}'s d20 could not be read`); return same; }
  const faces = roll
    ? (roll.dice?.[0]?.results ?? []).filter(x => !x?.rerolled).map(x => Number(x.result))
    : [kept];
  const got = await ownRoll({ actor, kind, what, d20s: faces, kept, total: Number(total),
    judge: (t) => ({ fails: t < Number(dc), words: `${t} against DC ${dc}, ${t >= Number(dc) ? "a success" : "a failure"}` }),
    dice });
  return got.spent ? { total: got.total, d20: got.d20, spent: true, note: got.note } : same;
}

/* ═══ 2014: AN ATTACK AGAINST THEM ════════════════════════════════════════ */

/**
 * 2014 Lucky when an attack is rolled against a creature: only when it is
 * about to hit. They roll a d20 and choose the attacker's die or theirs.
 */
export async function incomingHit(o) {
  const { target, attacker, itemName, result, ledger } = o;
  const same = { changed: false, spent: false };
  const feat = luckyFeat(target);
  if (!feat) {
    if (halflingTraitItem(target)) skip(target, `its "${halflingTraitItem(target).name}" is the halfling trait, not the Lucky feat`);
    return same;
  }
  if (feat.edition === "2024") { skip(target, "2024 Lucky answers before the attack is rolled, not after"); return same; }
  if (feat.missingUses) { skip(target, "its Lucky feat has no uses set on the item"); return same; }
  if (!(feat.left > 0)) { skip(target, "no luck points left"); return same; }
  if (!isAHit(result.hitResult)) { skip(target, `${nameOf(attacker)}'s attack already misses`); return same; }
  const me = target.uuid ?? target.id;
  if (ledger.spenders.has(me)) { skip(target, "it already spent a luck point on this roll"); return same; }
  const cancels = ledger.spenders.size > 0;

  await untilDiceLand(o.dice ?? "none");
  const words = `${result.attackTotal} against AC ${result.effectiveAC ?? result.ac}${result.hitResult === "critical" ? ", a critical" : ""}`;
  const ask = await askSpend({
    reactorActor: target, reactorToken: result.targetToken ?? null,
    attackerName: nameOf(attacker), attackerImg: attacker?.img ?? null,
    luckItemUuid: feat.item.uuid,
    description: cancels
      ? `${nameOf(attacker)}'s ${itemName} is about to hit you (${words}). ${nameOf(attacker)} already spent a luck point on this roll: if you spend one, the two cancel and the roll stands as first rolled. ${feat.left} of ${feat.max} left.`
      : `${nameOf(attacker)}'s ${itemName} is about to hit you (${words}). Spend a luck point, roll a d20, and choose which die the attack uses? ${feat.left} of ${feat.max} left.`,
    acceptLabel: "Spend a luck point", declineLabel: "Take the hit",
  });
  if (!ask.yes) { say(`${nameOf(target)} let the hit stand.`); return same; }
  const paid = ask.spentAlready || await spendLuck(feat.item);
  if (!paid) return same;
  ledger.spenders.add(me);

  if (cancels) {
    say(`${nameOf(target)} and ${nameOf(attacker)} both spent luck on the same roll: they cancel, no dice, it stands as first rolled (${ledger.original.d20}).`);
    return { changed: true, spent: true, cancelled: true, d20: ledger.original.d20, total: ledger.original.total,
      note: `Lucky: ${nameOf(attacker)} and ${nameOf(target)} both spent a luck point; they cancel and the roll stands as first rolled (${ledger.original.d20})` };
  }

  const fresh = await rollLuckDie(target, `against ${itemName}`);
  const theirs = Number(result.d20Result);
  const judgeWith = (face) => {
    const t = result.attackTotal - theirs + face;
    const hit = judgeAttack({ d20: face, total: t, ac: result.effectiveAC ?? result.ac,
      fullCover: !!result.coverResult?.isFullCover, mirrorImage: !!result.mirrorImageRedirect,
      autoCrit: !!result.autoCrit });
    return { t, hit };
  };
  const a = judgeWith(theirs), b = judgeWith(fresh);
  const label = (h) => h === "critical" ? "a critical hit" : h === "hit" ? "hits you" : h === "fumble" ? "a fumble, misses" : "misses";
  let picked = "theirs";
  if (fresh !== theirs) {
    picked = await askChoice({
      reactorActor: target, reactorToken: result.targetToken ?? null,
      attackerName: nameOf(attacker), attackerImg: attacker?.img ?? null,
      description: `Your luck die shows ${fresh}. Which die does ${nameOf(attacker)}'s attack use?`,
      choices: [
        { id: "theirs", label: `Their ${theirs}`, sub: `${a.t}, ${label(a.hit)}` },
        { id: "mine", label: `Your ${fresh}`, sub: `${b.t}, ${label(b.hit)}` },
      ],
    });
    if (picked == null) say(`${nameOf(target)} closed the choice without picking, so the attack keeps its own die.`);
  } else {
    say(`${nameOf(target)}'s luck die matches the attacker's (${fresh}), so there is nothing to choose.`);
  }
  const useMine = picked === "mine";
  const face = useMine ? fresh : theirs;
  const t = result.attackTotal - theirs + face;
  say(`${nameOf(target)} rolled ${fresh} with luck against ${nameOf(attacker)}'s ${itemName}; the attack uses ${useMine ? `${nameOf(target)}'s ${fresh}` : `its own ${theirs}`}.`);
  return { changed: useMine, spent: true, d20: face, total: t,
    note: `Lucky: ${nameOf(target)} rolled ${fresh}; the attack uses ${useMine ? `their ${fresh} (was ${theirs})` : `its own ${theirs}`}` };
}

/* ═══ ATTACKS: EVERYTHING AFTER THE ROLL ═════════════════════════════════ */

/** Put a new d20 and total on one attack result and judge it again. */
export function rejudge(r, d20, total) {
  r.d20Result = d20;
  r.attackTotal = total;
  r.isCritRoll = Number(d20) === 20;
  r.isFumbleRoll = Number(d20) === 1;
  r.hitResult = judgeAttack({ d20, total, ac: r.effectiveAC ?? r.ac,
    fullCover: !!r.coverResult?.isFullCover, mirrorImage: !!r.mirrorImageRedirect, autoCrit: !!r.autoCrit });
}

/**
 * 2014 Lucky for one attack roll, after its dice land and before Shield, the
 * card and the damage: the attacker's own luck when it is about to miss, each
 * target's luck when it is about to hit, and two spends on one roll cancelling.
 * Changes the results in place, and adds a `luck` line for the card.
 *
 * @param {object} o
 * @param {Actor} o.actor         the attacker
 * @param {Item} o.item
 * @param {object[]} o.results    the pipeline's per-target results
 * @param {number[]} [o.d20s]     every d20 face the roll showed
 * @param {"armed"|"none"} [o.dice]
 */
export async function afterAttackRoll({ actor, item, results, d20s = [], dice = "none" }) {
  if (!results?.length) return;
  const itemName = item?.name ?? "attack";
  const holders = [actor, ...results.map(r => r.targetActor ?? r.target?.actor ?? null)].filter(Boolean);
  if (!holders.some(a => luckyFeatItem(a) || halflingTraitItem(a))) return;   // nobody here has any luck

  // One roll, one ledger per target: who spent luck on the roll against that target.
  const first = { d20: Number(results[0].d20Result), total: Number(results[0].attackTotal) };
  for (const r of results) {
    r._luck = { spenders: new Set(), original: { d20: Number(r.d20Result), total: Number(r.attackTotal) } };
  }
  let waited = false;
  const diceOnce = () => { const d = waited ? "none" : dice; waited = true; return d; };

  // 1. The attacker's own 2014 luck, when a better d20 could turn a miss.
  const couldTurn = results.filter(missADieCouldChange);
  if (couldTurn.length) {
    const words = (total, d20) => {
      const out = results.map(r => judgeAttack({ d20, total: total - first.total + Number(r.attackTotal),
        ac: r.effectiveAC ?? r.ac, fullCover: !!r.coverResult?.isFullCover,
        mirrorImage: !!r.mirrorImageRedirect, autoCrit: !!r.autoCrit }));
      const fails = out.some((h, i) => !isAHit(h) && missADieCouldChange(results[i]));
      const txt = results.length === 1
        ? `${total} against AC ${results[0].effectiveAC ?? results[0].ac}, ${isAHit(out[0]) ? "hits" : "misses"}`
        : `${total}: ${results.map((r, i) => `${r.name} ${isAHit(out[i]) ? "hit" : "missed"}`).join(", ")}`;
      return { fails, words: txt };
    };
    const shared = results[0]._luck;
    const own = await ownRoll({ actor, kind: "attack", what: `attack with ${itemName}`, d20s,
      kept: first.d20, total: first.total, judge: words, ledger: shared, dice: diceOnce() });
    if (own.spent) {
      for (const r of results) {
        if (own.changed) rejudge(r, own.d20, Number(r.attackTotal) - first.d20 + own.d20);
        r.luck = own.note;
        r._luck.spenders = new Set(shared.spenders);
      }
    }
  } else if (luckyFeatItem(actor)) {
    skip(actor, "its attack already hits, or only full cover or a Mirror Image stopped it");
  }

  // 2. Each target's 2014 luck, when the attack is about to hit it.
  for (const r of results) {
    const target = r.targetActor ?? r.target?.actor ?? null;
    if (!target || target === actor) continue;
    const got = await incomingHit({ target, attacker: actor, itemName, result: r, ledger: r._luck, dice: diceOnce() });
    if (got.spent) {
      if (got.changed) rejudge(r, got.d20, got.total);
      r.luck = r.luck && !got.cancelled ? `${r.luck}. ${got.note}` : got.note;
      r._luck.targetSpent = !got.cancelled;
    }
  }

  // 3. The attacker's answer to a target's luck: spending now cancels it.
  for (const r of results) {
    if (!r._luck.targetSpent || isAHit(r.hitResult)) continue;
    const me = actor.uuid ?? actor.id;
    if (r._luck.spenders.has(me)) continue;
    const back = await ownRoll({ actor, kind: "attack", what: `attack with ${itemName} against ${r.name}`,
      d20s: [], kept: Number(r.d20Result), total: Number(r.attackTotal),
      judge: (total, d20) => {
        const h = judgeAttack({ d20, total, ac: r.effectiveAC ?? r.ac, fullCover: !!r.coverResult?.isFullCover,
          mirrorImage: !!r.mirrorImageRedirect, autoCrit: !!r.autoCrit });
        return { fails: !isAHit(h), words: `${total} against AC ${r.effectiveAC ?? r.ac}, ${isAHit(h) ? "hits" : "misses"}` };
      },
      ledger: r._luck, dice: "none" });
    if (back.cancelled) {
      rejudge(r, back.d20, back.total);
      r.luck = back.note;
    }
  }
  for (const r of results) delete r._luck;
}

/* ═══ 2024: BEFORE AN ATTACK IS ROLLED ═══════════════════════════════════ */

/** attacker id → { at, by } : the answer for the swing about to be rolled. */
const _beforeRoll = new Map();
const BEFORE_ROLL_TTL_MS = 60000;

/** The targets whose 2024 Lucky could still answer this attacker. */
function luckyTargets(attacker, targets) {
  const out = [];
  for (const t of targets ?? []) {
    const a = t?.actor ?? null;
    if (!a || a === attacker) continue;
    const feat = luckyFeat(a);
    if (!feat || feat.edition !== "2024") continue;
    out.push({ token: t, actor: a, feat });
  }
  return out;
}

/** Has this swing's 2024 question been asked already? */
export function beforeRollAsked(attacker) {
  const rec = _beforeRoll.get(attacker?.id);
  return !!rec && (Date.now() - rec.at) < BEFORE_ROLL_TTL_MS;
}

/** Does this swing still need the 2024 question? */
export function needsBeforeRoll(attacker, targets) {
  if (beforeRollAsked(attacker)) return false;
  return luckyTargets(attacker, targets).some(x => !x.feat.missingUses && x.feat.left > 0);
}

/**
 * 2024 Lucky, before the attacker's roll is locked: one box per target that
 * has the feat and a point, "spend 1 to give that attack Disadvantage?". The
 * answer waits for the roll, which reads it with `takeBeforeRoll`.
 */
export async function beforeAttackRoll({ attacker, item, targets }) {
  const by = [];
  for (const { token, actor, feat } of luckyTargets(attacker, targets)) {
    if (feat.missingUses) { skip(actor, "its Lucky feat has no uses set on the item (set Uses to @prof, back on a long rest)"); continue; }
    if (!(feat.left > 0)) { skip(actor, "no luck points left"); continue; }
    const ask = await askSpend({
      reactorActor: actor, reactorToken: token ?? null,
      attackerName: nameOf(attacker), attackerImg: attacker?.img ?? null,
      luckItemUuid: feat.item.uuid,
      description: `${nameOf(attacker)} is attacking you with ${item?.name ?? "an attack"}. Spend a luck point to give that attack Disadvantage? ${feat.left} of ${feat.max} left.`,
      acceptLabel: "Give it Disadvantage", declineLabel: "Let it roll",
    });
    if (!ask.yes) { say(`${nameOf(actor)} let ${nameOf(attacker)}'s attack roll as it is.`); continue; }
    const paid = ask.spentAlready || await spendLuck(feat.item);
    if (paid) by.push(nameOf(actor));
  }
  _beforeRoll.set(attacker?.id, { at: Date.now(), by });
  if (by.length) say(`${by.join(" and ")} spent luck: ${nameOf(attacker)}'s attack with ${item?.name ?? "that attack"} rolls with Disadvantage.`);
  return { disadvantage: by.length > 0, by };
}

/** The 2024 answer for this attacker's roll, taken once. Null when none was asked. */
export function takeBeforeRoll(attacker) {
  const rec = _beforeRoll.get(attacker?.id);
  _beforeRoll.delete(attacker?.id);
  if (!rec || (Date.now() - rec.at) >= BEFORE_ROLL_TTL_MS) return null;
  return rec;
}

/**
 * Put Lucky's Disadvantage together with the roll's own mode. Advantage and
 * Disadvantage cancel however many of each there are (RAW).
 * @returns {"advantage"|"normal"|"disadvantage"}
 */
export function withLuckDisadvantage(mode, hasAdvantageSource) {
  if (hasAdvantageSource || mode === "advantage") return "normal";
  return "disadvantage";
}

/* ═══ 2024: THE BUTTON ON THEIR OWN ROLL CARD ════════════════════════════ */

/**
 * The Lucky button for this roller's own card, or null. Only for the 2024 feat
 * with a point left, and only on the screen of whoever decides for the
 * creature: its connected owner, else the GM.
 */
export function buttonFor(actor) {
  const feat = luckyFeat(actor);
  if (!feat) return null;
  if (feat.edition !== "2024") return null;
  if (feat.missingUses) { skip(actor, "its Lucky feat has no uses set on the item, so there is no button"); return null; }
  if (!(feat.left > 0)) { skip(actor, "no luck points left, so no button"); return null; }
  const who = whoAnswers(actor);
  if (who.user && who.user.id !== game.user?.id) {
    skip(actor, `the button belongs on ${who.user.name}'s screen (${who.why})`);
    return null;
  }
  return { left: feat.left, max: feat.max, item: feat.item };
}

/**
 * The button was pressed: spend the point and say what the roll becomes.
 * @param {Actor} actor
 * @param {{hasDisadvantage?: boolean}} [o]
 * @returns {Promise<"advantage"|"normal"|null>} null when nothing was spent
 */
export async function pressButton(actor, { hasDisadvantage = false } = {}) {
  const feat = luckyFeat(actor);
  if (!feat || feat.edition !== "2024" || !(feat.left > 0)) {
    skip(actor, "the Lucky button was pressed with no 2024 feat or no point left");
    return null;
  }
  const paid = await spendLuck(feat.item);
  if (!paid) return null;
  if (hasDisadvantage) {
    say(`${nameOf(actor)} pressed Lucky: its Advantage cancels the roll's Disadvantage (RAW), so it rolls straight.`);
    return "normal";
  }
  say(`${nameOf(actor)} pressed Lucky: the roll has Advantage.`);
  return "advantage";
}

/* ═══ 2024: THE PLAYER SAVE CARD'S BUTTON, KEPT ACROSS A RELOAD ═════════ */

/** Mark the save card whose roll the luck point was spent on, on the feat item. */
export async function markCardAdvantage(actor, messageId) {
  const item = luckyFeatItem(actor);
  if (!item) return false;
  try { await item.setFlag(MODULE_ID, "luckyAdvantageFor", messageId); return true; }
  catch (err) { console.warn(`${LOG} | could not note which card ${nameOf(actor)}'s luck was spent on:`, err); return false; }
}

/** Was the luck spent for this card's roll? */
export function cardHasAdvantage(actor, messageId) {
  try { return !!messageId && luckyFeatItem(actor)?.getFlag?.(MODULE_ID, "luckyAdvantageFor") === messageId; }
  catch (_) { return false; }
}

/** Take the mark: the roll it was spent on is happening now. */
export async function takeCardAdvantage(actor, messageId) {
  if (!cardHasAdvantage(actor, messageId)) return false;
  try { await luckyFeatItem(actor)?.unsetFlag?.(MODULE_ID, "luckyAdvantageFor"); }
  catch (err) { console.warn(`${LOG} | could not clear ${nameOf(actor)}'s used luck mark:`, err); }
  return true;
}

/* ═══ WIRING ════════════════════════════════════════════════════════════════ */

/**
 * The halfling's reroll on dnd5e's own rolls, for a creature whose trait sets
 * no flag (Chudd): attacks, checks, saves, death saves and initiative. dnd5e
 * reads its own flag for every one of those, so a creature that carries the
 * flag (Perrin) is left to dnd5e.
 *
 * ⚠️ ONE HOOK FOR EVERY d20 TEST. dnd5e fires "d20Test" for an attack, a
 * check, a save and a death save alike (a death save is a saving throw
 * underneath), so a second listener for death saves would only say it twice.
 */
export function registerLuck() {
  const actorOf = (subject) => subject?.actor ?? (subject?.documentName === "Actor" ? subject : null) ?? subject ?? null;
  // What the roll is, in words, for the log: dnd5e names it in hookNames.
  const whatOf = (config) => {
    const n = new Set((config?.hookNames ?? []).map(h => String(h).toLowerCase()));
    return n.has("deathsave") ? "death save" : n.has("attack") ? "attack roll"
      : n.has("concentration") ? "concentration save" : n.has("savingthrow") ? "saving throw"
      : (n.has("skill") || n.has("tool") || n.has("abilitycheck")) ? "check" : "d20 roll";
  };
  const onD20 = (config) => {
    const what = whatOf(config);
    try {
      const actor = actorOf(config?.subject);
      if (!actor || config.halflingLucky) return;
      if (!hasHalflingLuck(actor)) return;
      config.halflingLucky = true;
      if (!actor.getFlag?.("dnd5e", "halflingLucky")) {
        say(`${nameOf(actor)}'s ${what} rerolls a 1 (halfling trait "${halflingTraitItem(actor)?.name ?? "Lucky"}").`);
      }
    } catch (err) {
      console.warn(`${LOG} | could not add halfling luck to a ${what}:`, err);
    }
  };
  Hooks.on("dnd5e.preRollD20TestV2", (config) => onD20(config));
  Hooks.on("dnd5e.preConfigureInitiative", (actor, rollConfig) => {
    try {
      if (!hasHalflingLuck(actor)) return;
      rollConfig.options = rollConfig.options ?? {};
      if (rollConfig.options.halflingLucky) return;
      rollConfig.options.halflingLucky = true;
      say(`${nameOf(actor)}'s initiative rerolls a 1 (halfling trait "${halflingTraitItem(actor)?.name ?? "Lucky"}").`);
    } catch (err) {
      console.warn(`${LOG} | could not add halfling luck to initiative:`, err);
    }
  });
  // ⚠️ A DEATH SAVE IS A SAVE, AND dnd5e WRITES IT BEFORE ANYONE CAN ASK.
  // rollDeathSave works out the tally and writes it straight after its hook,
  // and a hook cannot wait for a box. So for a 2014 Lucky holder whose death
  // save is about to fail, ACE stops dnd5e's write, asks, and writes the same
  // tally dnd5e would have from the die the luck left: a success, a critical
  // (back up with 1 hit point), a failure, or two on a 1.
  Hooks.on("dnd5e.rollDeathSaveV2", (rolls, details) => {
    try {
      const actor = details?.subject ?? null;
      const roll = Array.isArray(rolls) ? rolls[0] : rolls;
      if (!actor || !roll || roll._aceLuckTaken) return undefined;
      const target = Number(roll.options?.target ?? 10);
      if (Number(roll.total) >= target) return undefined;
      const feat = luckyFeat(actor);
      if (!feat || feat.edition !== "2014" || feat.missingUses || !(feat.left > 0)) return undefined;
      Object.defineProperty(roll, "_aceLuckTaken", { value: true, enumerable: false, configurable: true });
      const outcome = deathSaveWithLuck(actor, roll, rolls, target).catch(err => {
        console.error(`${LOG} | ${nameOf(actor)}'s death save could not be finished after the Lucky box; `
          + `nothing was written. Mark it on the sheet:`, err);
        ui.notifications?.error(`ACE could not finish ${nameOf(actor)}'s death save. Mark it on the sheet (the console has why).`);
      });
      Object.defineProperty(roll, "_aceOutcome", { value: outcome, enumerable: false, configurable: true, writable: true });
      return false;   // ACE writes it, after the luck
    } catch (err) {
      console.warn(`${LOG} | could not offer Lucky on a death save; dnd5e writes it as rolled:`, err);
      return undefined;
    }
  });
  console.log(`${LOG} | online: the Lucky feat (2014 and 2024) and the halfling's Lucky.`);
}

/** A 2014 Lucky holder's failing death save: ask, then write what dnd5e would have. */
async function deathSaveWithLuck(actor, roll, rolls, target) {
  let total = Number(roll.total);
  let d20 = naturalD20(roll);
  const lk = await againstDC({ actor, kind: "save", what: `death saving throw (DC ${target})`,
    roll, total, d20, dc: target, dice: "show" });
  if (lk.spent) {
    total = lk.total; d20 = lk.d20;
    Object.defineProperty(roll, "_aceLuck", { value: { total, d20, note: lk.note }, enumerable: false, configurable: true, writable: true });
  }
  const death = actor.system?.attributes?.death ?? {};
  const critAt = Number(roll.options?.criticalSuccess ?? 20);
  const fumbleAt = Number(roll.options?.criticalFailure ?? 1);
  let updates = {};
  let chatString = null;
  if (total >= target) {
    const successes = (Number(death.success) || 0) + 1;
    if (Number(d20) >= critAt) {
      updates = { "system.attributes.death.success": 0, "system.attributes.death.failure": 0, "system.attributes.hp.value": 1 };
      chatString = "DND5E.DeathSaveCriticalSuccess";
    } else if (successes === 3) {
      updates = { "system.attributes.death.success": 0, "system.attributes.death.failure": 0 };
      chatString = "DND5E.DeathSaveSuccess";
    } else {
      updates = { "system.attributes.death.success": Math.clamp(successes, 0, 3) };
    }
  } else {
    const failures = (Number(death.failure) || 0) + (Number(d20) <= fumbleAt ? 2 : 1);
    updates = { "system.attributes.death.failure": Math.clamp(failures, 0, 3) };
    if (failures >= 3) chatString = "DND5E.DeathSaveFailure";
  }
  await actor.update(updates);
  say(`${nameOf(actor)}'s death save: ${total} against ${target}${lk.spent ? " after luck" : ""}; written as dnd5e would.`);
  let message = null;
  if (chatString) {
    const chatData = {
      content: game.i18n.format(chatString, { name: actor.name }),
      speaker: ChatMessage.getSpeaker({ actor }),
    };
    // dnd5e posts this line in the table's roll mode; so does ACE.
    try { ChatMessage.applyRollMode?.(chatData, CONFIG.Dice?.BasicRoll?.getMessageMode?.() ?? game.settings.get("core", "rollMode")); }
    catch (err) { console.warn(`${LOG} | could not read the roll mode for ${nameOf(actor)}'s death save line; it posts publicly:`, err); }
    message = await ChatMessage.create(chatData);
  }
  Hooks.callAll("dnd5e.postRollDeathSave", rolls, { message, subject: actor });
}

export const Luck = {
  luckyFeatItem, luckyFeat, featEdition, luckPoints, halflingTraitItem, hasHalflingLuck,
  withHalflingLuck, halflingRerolled, spendLuck, spendLuckByUuid,
  ownRoll, againstDC, incomingHit, afterAttackRoll, rejudge,
  beforeAttackRoll, needsBeforeRoll, beforeRollAsked, takeBeforeRoll, withLuckDisadvantage,
  buttonFor, pressButton, markCardAdvantage, cardHasAdvantage, takeCardAdvantage,
  registerLuck,
};
