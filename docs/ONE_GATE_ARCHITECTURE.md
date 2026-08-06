# THE ONE GATE — a single resolution path for every action

**Status:** **Phase 0 BUILT (0.7.397, 2026-08-06)** — awaiting live confirm. Phases 1–4 planned.
**Author:** Johnny + Claude, 2026-08-06
**Trigger:** a dead Specter rolled two saves against Petrifying Gaze, then was told
it was immune to the outcome. Johnny: *"It's an attack! It has to go through the
attack pipeline."*

---

## 0. The one-line statement

**Nothing rolls a die for a target until a single shared Gate has read the
attacker, the environment, and that target, and returned a verdict.**

An attack roll and a saving throw are not different *kinds of thing*. They are two
**resolution methods** for the same event: *someone does something to someone else.*
Today they live in different files with different rules about what gets checked.
That is the whole bug, and every instance of it we have chased is the same bug.

---

## 1. Why this keeps happening — measured, not asserted

There are **five independent pipelines** (attack, save, damage, spell, heal), and each
decides for itself what to check. Actual counts from `save-engine.mjs` on 0.7.396:

| The save engine consults… | Calls |
|---|---|
| `saveMod` on the target profile | 7 |
| `hp` (only to draw the damage/skull line) | 4 |
| `immuneToCondition` (**after** the roll) | 3 |
| `autoFailsSave` | 1 |
| **Attacker profile** | **0 — never built** |
| **Environment** (`SpaceEffects`, regions, cover, obscurement) | **0** |
| **`CombatContext.canAct`** — the liveness / hard gate | **0** |
| **`RulesBrain`** | **0** |

The target profile exposes ~25 fields (`hasCondition`, `petrified`, `blinded`,
`frightened`, `exhaustion`, `magicResistant`, `legendaryResistances`, `creatureType`,
`size`, `armorProf`, `disposition`, `isPC`, `ac`, …). **Four are read.**

Meanwhile `attack-pipeline.mjs:298` *does* gate correctly — on the attacker only.

⚠️ **The lesson to internalise:** "the pipelines were converted to read profiles"
was true in the sense that they *build* a profile instead of poking the actor
directly. It was false in the sense that matters. **Building a profile and
consulting it are different things.** Never again report the first as the second.

---

## 2. The model

Every action in the game is one shape:

```
ACTOR  --[ does ITEM/ACTIVITY ]-->  TARGET(S)   within an ENVIRONMENT
```

The differences people think are structural are actually just fields:

| | Weapon swing | Spell attack | Save spell | Gaze / aura / trap |
|---|---|---|---|---|
| Resolution | attack roll vs AC | attack roll vs AC | save vs DC | save vs DC |
| Range | reach | range | range/area | line of sight / radius |
| Consumes | ammo/action | slot/action | slot/action | often nothing |

**Same event. Same three-way scan. Different resolution method.** So there is one
pipeline with a `resolution` field, not five pipelines.

---

## 3. The Gate — the single contract

One module. One entry point. Every engine calls it and **may not roll without it**.

```js
// scripts/gate/action-gate.mjs
const verdicts = await ActionGate.open({
  actor, token, item, activity,
  targets,                       // TokenDocument[]
  resolution: "attack" | "save" | "auto",
  saveAbility, dc,               // when resolution === "save"
  outcomes: ["petrified", …],    // conditions/effects this action can inflict
  damageTypes: ["fire", …],
});
```

Returns **one verdict per target**, and the verdict is the only thing that decides
whether a die is thrown:

```js
{
  target, targetProfile, attackerProfile, environment,
  outcome: "roll" | "no-roll" | "auto-fail" | "auto-succeed",
  reason:  "dead" | "immune-to-all-outcomes" | "out-of-range" | "no-line-of-sight" |
           "cannot-act" | "auto-fail-condition" | "legendary-resistance-available" | null,
  modifiers: { advantage, disadvantage, sources: [...] },
  display: { label, colour, icon },      // exactly what the card should print
}
```

### 3.1 What the Gate reads — the three scans

**ATTACKER** (built via `buildAttackerProfile`, which the save flow has never used)
- can it act at all — `CombatContext.canAct`
- concentration already held, and on what
- resources: slot / charges / ammo / recharge
- save DC and any DC bonuses (the Stormforger +2 bug lives here)
- effects granting "targets have disadvantage on saves"
- conditions on the attacker that change the action (blinded, frightened of target,
  prone, restrained, poisoned)

**ENVIRONMENT**
- distance attacker→target, against reach/range/long-range
- line of sight and line of effect — walls, via `CONFIG.Canvas.polygonBackends`
- cover (half / three-quarters / total) → AC and DEX-save bonus
- spaces at BOTH ends: darkness, fog, silence, difficult terrain, web
- obscurement → advantage / disadvantage
- elevation and flight where relevant

**TARGET**
- **alive** — HP > 0, no `dead` status ← *the Specter*
- can it act (for anything requiring a reaction)
- every condition, via `Situation.readStatuses`
- immunity / resistance / vulnerability to each damage type
- immunity to each *outcome condition* ← **checked BEFORE the roll**
- auto-fail / auto-succeed rules (paralyzed auto-fails STR/DEX, etc.)
- legendary resistance remaining
- magic resistance (the MM feature that was silently missed for weeks)
- creature type gates (undead/construct ignore poison, etc.)

### 3.2 The ordering rule that fixes the Specter

The Gate resolves in this order and **stops at the first decisive answer**:

1. Is the target a legal target at all? (exists, alive, on this scene)
2. Can the action reach it? (range, line of effect)
3. Can the action *do anything* to it? (immune to every outcome AND all damage types)
4. Is the result forced? (auto-fail / auto-succeed)
5. Otherwise → **roll**, carrying the advantage/disadvantage the scans produced.

A dead Specter stops at step 1. An immune creature stops at step 3. **Neither ever
reaches a die.** Today both reach step 5 and the contradiction is printed afterwards.

---

## 4. The card must show the verdict

Every non-roll verdict is displayed, never silently dropped — Johnny, 2026-08-06:
*"I want us to be able to see it."*

| Verdict | Row shows |
|---|---|
| dead | `☠ DEAD — no save` (grey) |
| immune to all outcomes | `🛡 IMMUNE to Petrified — no save` (**orange**, not blue) |
| out of range | `⟶ OUT OF RANGE (65 ft / 60 ft)` |
| no line of effect | `⛌ NO LINE OF EFFECT — wall` |
| auto-fail | `✖ AUTOMATIC FAIL — paralyzed` |
| legendary resistance | the roll, plus a `LEGENDARY RESISTANCE` button |
| roll | the d20 as now |

Also fix now: the target name gets its own line (it currently breaks mid-word —
"Specte / r"), and the immunity colour moves from `#6bcbff` to the orange used for
warnings (`save-engine.mjs:4931`).

---

## 5. How it can never regress

A fix that isn't enforced is a fix that comes back. Three layers:

1. **Chokepoint by construction.** The roll helpers move behind the Gate. `rollSave`,
   `rollAttack`, `applyCondition` take a `verdict` argument and **throw** without one.
   A new engine physically cannot roll without passing through.
2. **Self-test cases** in the existing `SelfTest` harness — dead target, immune
   target, out-of-range, auto-fail, legendary resistance, cover — asserted for every
   resolution method. `game.aceQol.selfTest()` fails loudly if any regress.
3. **Lint + watchdog.** An ESLint rule banning direct `roll*` calls outside the Gate,
   and a `RulesWatchdog` invariant: *no creature at 0 HP holds a pending save*.

---

## 6. Delivery order

**Phase 0 — ✅ BUILT in 0.7.397 (2026-08-06).** Dead targets shown as "dead, no save";
immunity checked before the roll; card colour + name wrapping.

What actually shipped, and where:

| Piece | Location |
|---|---|
| `isDead` / `canAct` accessors | `profiles/target-profile.mjs` |
| `_preRollVerdict(profile, {outcomeConditions, dealsDamage})` | `save-engine.mjs` |
| `_verdictForTargetRow(tgt, opts)` — resolves the actor | `save-engine.mjs` |
| `_noRollRow(tgt, verdict, {isPC})` — one row shape | `save-engine.mjs` |
| `_outcomeConditionsFor(item)` — pre-roll outcome source | `save-engine.mjs` |
| `_failedTheSave(r)` — the "one reader" for failure | `save-engine.mjs` |
| Gate suite, 15 cases | `rules/self-test.mjs` (suite 9) |
| `dead-with-pending-resolution` invariant | `rules-watchdog.mjs` |

**The chokepoint arrived early.** The gate sits at the top of `_rollSingleSave`, which is
the single door all three NPC roll sites come through — so a fourth caller added later is
gated by construction, not by somebody remembering. The three PC entry points (prompt
dispatch, the pcResults builder, and "add targets") call the same `_verdictForTargetRow`.

**RAW calls made, and why they matter:**
- **A PC at 0 HP is NOT dead** — unconscious and dying, still a legal target, still rolls
  (auto-failing STR/DEX). Gating players on HP would stop a downed party member being
  affected by *anything*, which is a worse bug than the one being fixed. Only the `dead`
  marker gates a player; the HP branch is NPC-only. Both editions agree monsters die at 0.
- **Immunity only cancels the save when nothing else is left to resolve.** Immune to the
  condition but the spell also deals damage → it still rolls, because the save is doing
  work for half damage. The card notes the immunity.

**Fails OPEN, deliberately.** No profile, unreadable outcomes, or a throw inside the Gate
all mean "roll normally", loudly logged. A gate that fails closed would silently delete
saves — the same shape as the wall checks that returned "no wall" from a catch block twice
on 2026-08-06.

**Downstream was the real risk.** A no-roll row carries `passed: false`, which six call
sites read as *failed the save* — that would have applied conditions to the corpse. All six
now route through `_failedTheSave`.

⚠️ **Known limit, for Phase 1:** `_outcomeConditionsFor` reads only the spell registry.
Items whose conditions come from the staged-chain metadata or the parsed description return
`[]`, so the immunity gate is inert for them and they roll as before — correct, but not yet
complete. Also, `_targetProfileFor` caches for 5 s, so a creature that dies *during* a
resolution can be seen as alive for that window. Neither affects the Specter case (already
dead before the cast), but both belong in the real Gate.

**Phase 1 — build the Gate (~half a day).** `action-gate.mjs` with the three scans and
the verdict object. Route the **save engine** through it first — that is where the
hole is.

**Phase 2 — converge the rest (~half a day).** Attack, damage, spell and heal
pipelines call the same Gate. Delete the per-engine ad-hoc checks they each grew.

**Phase 3 — enforcement (~2 hours).** Roll helpers demand a verdict; self-test cases;
lint rule; watchdog invariant.

**Phase 4 — the long tail.** Gaze, auras, traps, regions and Forge-built items enter
through the same door. Once the Gate exists this is mostly deletion.

---

## 7. What this kills, permanently

- Dead creatures acting or being acted upon
- Immune creatures rolling pointless dice
- Out-of-range and through-wall targeting
- Missed magic resistance, legendary resistance, auto-fail conditions
- Cover and obscurement remembered in one pipeline and forgotten in another
- Any future engine quietly forgetting a check — it cannot roll without asking

**One door. Three scans. A verdict before every die.**
