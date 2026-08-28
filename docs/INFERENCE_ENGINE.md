# THE INFERENCE ENGINE — read the thing, work out what happens

**Status:** built and wired, 2026-08-28. ACE QOL 0.8.71.

> Johnny, 2026-08-28: *"I'm trying to build a smart engine that can figure this
> shit out on its own, at least for 99% of it. I'm not trying to sit here and
> patch every goddamn spell and differentiation in the spell or attack or
> whatever. I'm trying to build the engine that looks at it and says, this is
> what's going to happen."*

---

## 0. The one-line statement

**The registry is a cache, not the product.** ACE reads any item — spell, weapon,
feat, trait, monster action — works out how it resolves from its own data and
rules text, remembers the answer, and never needs a human to have typed an entry.

Before this, `SpellPipeline._getEntry` was a pure name lookup against 125
hand-written keys. Anything else returned null and ACE had no plan for it. Every
gap was closed by writing another entry by hand, which is exactly the treadmill
this replaces.

---

## 1. The eight questions

Range is **not** a commonality. It is one answer to one of them. Magic Resistance
has no range, a trait has no range, an aura has a radius, a touch spell has
neither. Build the engine around a `range` field and every one of those becomes a
special case.

The thing they share is the **question**: does this reach the target at all?
Range answers it for a bow, radius for an aura, "touch" for Cure Wounds, "self"
for Shield, and "it is simply always on" for Magic Resistance. Five answer
shapes, one question.

`scripts/inference/action-facts.mjs` answers eight questions about anything, and
every one is always answered even when the answer is "nothing":

| # | Question | Answers it can give |
|---|---|---|
| 1 | **trigger** — what sets it off | activated, reaction, passive, legendary, lair |
| 2 | **cost** — what it takes | action / bonus / reaction / free, slot level, uses, recharge, ammunition |
| 3 | **scope** — who it lands on | self, one, several, area, nobody |
| 4 | **delivery** — whether it arrives | self, touch, reach, ranged, area, emanation, unlimited, none — plus the senses it needs |
| 5 | **resolution** — how it is decided | attack roll, saving throw, automatic, none |
| 6 | **change** — what actually changes | damage, healing, conditions, effects, summons |
| 7 | **duration** — how long | instant, timed, permanent, dispelled, special, concentration |
| 8 | **interference** — what blunts it | damage types, conditions inflicted, repeated saves, creature-type gates, material bypasses |

`scripts/inference/classify-item.mjs` then **decides** from those eight answers.
It reads nothing itself: one reader, one decider, because two readers of one item
drift apart the way ACE's two template geometries did.

---

## 2. Measured, not asserted

Run `tools/inference-coverage.mjs` against a copy of the live world.

**2,637 unique spells and features in hijinx:**

| | |
|---|---|
| covered by hand-written entries | 119 |
| the engine plans on its own | 1,518 |
| of those, never curated by anyone | 1,405 |
| it declines, and says so | 1,119 |

**Agreement with the hand-written entries: 75 of 101.** That is the number that
matters, and it is why curated entries always win and why every reading is
reviewable. It went 52 → 68 → 75 as three real bugs were found:

1. **Touch and self are ranges, not shapes.** An early `isTouch` branch swallowed
   Invisibility, Tongues, Stoneskin, Heroism, Resistance, Death Ward, Foresight
   and Protection from Evil — nine buffs that merely happen to be delivered by
   touch.
2. **Shapes were ordered by their names, not by what they do.** In the pipeline
   `touch` means "one adjacent creature, then heal or damage it" and `multi-buff`
   means "pick creatures and apply an effect". Guessing from the names cost a
   whole round of this.
3. **An emanation that asks nothing of anybody is the caster, not an area.**
   Detect Magic carries a 30 foot radius and does nothing to anyone in it.

Three of the remaining disagreements (Faerie Fire, Stinking Cloud, Sleet Storm)
are a measurement artifact: the offline harness does not feed `spell-timing`, and
that is the only thing that separates an area which resolves once from one that
keeps catching people.

---

## 3. Safety

**Curated always wins.** Inference runs only when the hand-written registry has
nothing, so no spell that works today can start behaving differently.

**High confidence only.** Medium means the description filled a gap the sheet left
blank, or a duration was used to assume something. Those fall through to the
generic engine exactly as they do today. A confident wrong plan is worse than no
plan.

**It changes behaviour, and that is the point.** An unregistered item used to fall
through to the generic save engine and now the pipeline claims it. `inferenceEngine`
(world setting, default on) turns it off, and off means precisely as it behaved
before this existed.

**A human correction is permanent.** `game.aceQol.correctShape(item, "save-single")`
writes a flag the classifier may never overwrite — through item edits, reboots,
and future versions of this engine.

---

## 4. The memory

`scripts/inference/learned-store.mjs`, world-scoped, GM-written.

Consistency is the reason, not speed. Re-deriving on every cast is cheap; a spell
resolving one way at the start of a fight and another way at the end because
somebody edited an item is not acceptable.

The key carries a **fingerprint** of the facts that produced the plan, so editing
an item produces a fresh reading rather than acting on a stale one forever. A
human correction is stored against the name and deliberately ignores the
fingerprint: correcting a shape is a statement about the spell, not about one
revision of its data.

---

## 5. Where it plugs in

```
button pushed
      |
      v
SpellPipeline._getEntry
      |-- curated registry?  ---> use it, always wins
      |-- corrected by hand?  ---> use that, permanent
      |-- learned already?    ---> use it, instant
      |-- classify now        ---> high confidence only, then remember
      +-- otherwise null      ---> generic engine, exactly as before
      |
      v
  THE ONE GATE  (docs/ONE_GATE_ARCHITECTURE.md)
  attacker + environment + target, a verdict before every die
```

---

## 6. The console

```
game.aceQol.explain(item)          what ACE makes of one thing, and why
game.aceQol.reviewInference()      everything it worked out for the party
game.aceQol.correctShape(i, "...") overrule it, permanently
game.aceQol.forgetLearned()        make it read everything again
```

## 7. Checks

```
node tools/engine-selftest.mjs      32 cases, every one a bug that really happened
node tools/gate-selftest.mjs        10 cases on the Gate's verdicts
node tools/elevation-selftest.mjs   17 cases on area height
node tools/inference-coverage.mjs   measure against a copy of the live world
```
