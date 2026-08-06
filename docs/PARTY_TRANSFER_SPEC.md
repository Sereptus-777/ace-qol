# ACE — Party Transfer ("the Hand")

**Status:** ✅ BUILT in ace-qol 0.7.384 — `scripts/party-transfer.mjs` · awaiting live test
**Author:** Johnny + Claude, 2026-08-01

**Console handle:** `game.aceQol.partyTransfer` · **Toolbar:** two buttons at the
bottom of the Token layer controls (GM only).

### Deviations from this design, and why

- **Formation memory closes the group up past a 12-square spread.** Marching
  order is what's worth preserving; reproducing a scattered battlefield would
  land people across — or off — the new map.
- **A drop that misses the map is rejected**, not clamped. Missing is a
  mis-drop, not an instruction; the creatures stay in hand.
- **A bearer and burden are pulled in from either end.** Grabbing either one
  brings the other, not just bearer→burden as originally written.
- **Carrying capacity was NOT built** (it was marked optional). No setting was
  registered for it — a toggle that does nothing is a lie in the UI.

---

## 1. The problem

In Foundry a Token is a *per-scene* document. A character standing on twelve
maps is twelve TokenDocuments pointing at one Actor. Scenes are deliberately
self-contained — that's what lets an adventure pack ship a map with tokens
already on it — but the cost is that **nothing in core knows where the party
actually is.**

Consequences, all observed live:

- Teleporters **create** a token rather than moving one, so arriving somewhere
  you've been before gives you duplicates.
- Nothing cleans up behind you. Leave a map and the party is still standing on it.
- Combat holds a token id. Change scenes and that id points at a creature on a
  map you've left — the turn marker silently stops advancing, saves can't find
  their target, condition visuals attach to nothing. (Cost: two days, 2026-08-01.)

**The fix is not "make combat smarter." It is "make a creature exist once."**

## 2. The model — the Hand

One concept underneath everything: a **carry manifest**, the Hand.

- **Transfer** lifts chosen tokens off the current scene into the Hand.
- **Place** takes them out of the Hand and lands them on another scene.
- The Hand survives scene changes, reloads, and crashes.

The Hand stores each token's **full document data**, not its id — the original
is gone. Getting that data complete is where the difficulty lives.

## 3. ⚠️ Durability, and the unlinked-token problem

This is the hard part and the reason the design is shaped the way it is.

**Linked tokens (the party)** are easy. The Actor is the source of truth; the
token is a puppet. Lose the Hand entirely and you can drag them out of the
Actors sidebar by hand. You lose positions, not people.

**Unlinked tokens (most NPCs)** carry their own state — HP, conditions, items,
effects — in the token's ActorDelta, on the scene. Delete that token and the
only copy of a half-dead goblin is whatever we wrote down. Nothing in the
sidebar can bring it back.

### The rule: never let a creature exist only inside our data structure.

**Storage is two-layer, deliberately redundant:**

1. **The manifest** — a world setting holding the ordered list, formation,
   carry relationships, and each token's document data. Structured and fast.
   As durable as any other world data: Foundry writes settings to the database
   immediately, so a power cut loses no more than any other unsaved change.

2. **Transit Actors** — for **unlinked tokens only**, Transfer also creates a
   real Actor in a folder named **`ACE — In Transit`**, holding that creature's
   current state. (Johnny's idea, 2026-08-01, and it's the right one.)

Why the second layer earns its keep:

- It's a **first-class document**. It participates in Foundry's own backups,
  exports and world save. A JSON blob in a setting does not, to the same degree.
- It's **visible**. You can see what's in transit in the sidebar instead of
  trusting an invisible structure.
- It's **recoverable by hand**. If the manifest is ever lost or corrupt, the
  creatures are still sitting in a folder and you can drag them onto a map.
  That's the same safety net linked actors already have — extended to unlinked
  ones, which is exactly what they were missing.

**On Place:** the token is recreated **unlinked**, with its delta restored from
the Transit Actor, and the Transit Actor is then deleted. A creature must never
be left accidentally linked — that would silently join it to a shared sheet.

**On crash mid-transfer:** the folder is visibly present with its contents. On
next load, if the manifest and the folder disagree, trust the folder and rebuild
the manifest from it, then tell the GM what was recovered.

**Cleanup:** the folder is emptied as tokens land. A startup check reports any
strays ("3 creatures still in transit from a previous session") rather than
silently deleting them — a stray is evidence, not litter.

## 4. Transfer — picking up

Opens against the current scene.

- **Only Friendly and Neutral start ticked** (Johnny, 2026-08-02). It's *Party*
  Transfer — hostiles are scenery you're walking away from, not luggage.
- **Disposition bulk toggles:** Friendly · Neutral · Hostile · Secret.
  These *tick* everything of that disposition; they are not filters. Bringing
  the hostiles along is therefore one click when you actually mean to.
- **Collapsible list of every token**, individually tickable, for fine-tuning
  after the bulk pick.
- **Dead excluded by default**, with a toggle — sometimes the body comes too.
- **Incapacitated creatures need a bearer** (see §6).
- Confirm → tokens are lifted, origin scene is clean, Hand indicator appears.

**Delete-on-transfer, not delete-on-place.** The whole complaint is leftovers;
leaving ghosts until placement defeats the purpose. Justified by §3's redundancy
and §4's undo.

**Undo Transfer** restores everyone to the origin scene, in their original
positions, with their original ids, so long as nothing has been placed yet.

## 5. Place — putting down

Opens **the container** on the destination scene: the held tokens as portraits.

- **Shift-click** to group; drag a group onto the map and they spread around the
  drop point rather than stacking.
- Or pull them out one at a time.
- **Place all here** for travel between rooms, where arrangement doesn't matter.
- **Formation memory** — optionally land them in the same relative arrangement
  they were picked up in. Marching order survives the door.
- Each token **leaves the container the moment it lands and is confirmed**, so
  the container is always the honest list of what's still in hand. Interrupted
  halfway, you resume exactly where you were.

**Before anything lands: remove any existing copy of that creature on the
destination scene.** This is the point of the entire feature.

**Visibility on landing:**

| Case | Result |
|---|---|
| Was hidden when picked up | Stays hidden — never override |
| Hostile / Secret | Lands hidden by default (setting) |
| Friendly / Neutral | Lands visible |

One **Reveal** button acting on what was just placed, so an ambush springs on
your click rather than requiring you to find each token.

## 6. Carrying the fallen

A creature that is **unconscious, paralysed, petrified, stunned, incapacitated,
restrained, grappled or PRONE** cannot walk through the door under its own power.

⚠️ **Prone requires a bearer too** (Johnny, 2026-08-01 — corrected from an
earlier draft that only warned). A prone character is not crawling to another
map. Either somebody drags them or they get left behind, and being left behind
must never happen silently.

- Transfer notices and asks **who carries them**.
- The pair travels as a unit: drag the bearer, the burden comes.
- On landing, the burden is placed **adjacent to its bearer**.
- **If nobody can carry someone, Transfer says so and refuses** rather than
  quietly leaving them behind. Discovering you left Chudd in the temple two
  rooms later is the failure this prevents.
- **Prone** is lighter — they can crawl. Warn, don't block.
- *Optional, later:* RAW carrying capacity (Strength × 15 lb, doubled for
  dragging), so Firaxis can carry Chudd and the halfling can't.

The carry relationship is set at Transfer, held in the manifest, and consumed at
Place. The manifest is therefore **not a flat list** — some entries are attached
to others. Build that in from the start.

## 7. What travels

**Must carry:**
- The ActorDelta for unlinked tokens — HP, conditions, items, effects
- All flags — ours (species tag, flavour name) and other modules' (Automated
  Animations, Token Magic). Anything keyed to the token and not carried is
  silently lost.
- Elevation, rotation, scale, texture, vision and detection settings, light
  emission, hidden state, disposition, ownership, name and display settings

**Reassigned on landing:** position (that's the whole point)

**Keep the token id.** Foundry can create a document with a specified id, and
token ids need only be unique *within* a scene. Carrying the id means **every
reference to that token survives** — combat, Sequencer, our own flags. This one
decision would have prevented the bug that started this whole feature. Default on.

**Re-point the combat anyway**, belt and braces: a carried token that is in an
active combat has its combatant updated as it lands. A fight then genuinely
follows the party from map to map.

**Doesn't move itself — needs handling:**
- Sequencer persistent effects are bound to a scene; re-attach on landing or
  they're orphaned
- ACE condition visuals are derived and simply rebuild — no action needed

## 8. Failure modes to design against

| Failure | Handling |
|---|---|
| Crash mid-transfer | Transit folder is truth; rebuild manifest, report |
| Interrupted mid-place | Per-token confirmation; resume from container |
| Destination has an existing copy | Removed before landing (§5) |
| Multiple existing copies | Remove all of them |
| No room / drop off-canvas | Reject the drop, keep the token in hand |
| Bearer placed, burden not | Burden follows automatically; never separable |
| Transit strays at startup | Report, never auto-delete |
| Manifest corrupt | Fall back to Transit folder + Actors sidebar |

## 9. Settings

- Exclude dead from Transfer *(default on)*
- Hostiles arrive hidden *(default on)*
- Remove existing copies on destination *(default on)*
- Preserve token ids *(default on)*
- Formation memory *(default on)*
- Enforce carrying capacity *(default off)*

## 10. Out of scope for v1

- Cross-**world** transfer
- Automatic transfer on scene activation — explicit only; one misclick should
  never relocate a party mid-session
- Player-initiated transfer (GM-only operation)
- Collapsing the party into a single travel token (the container already serves
  this purpose in practice)

## 11. Upstream

The gap this fills does not appear to exist in core, and no upstream feature
request for it was found (researched 2026-08-01). Foundry's answer is Scene
Region "Teleport Token" behaviour, which does support cross-scene destinations
but has open issues around permissions, view-following and linked-region loops.
Community modules either move on demand (Group Tokens), collapse the party
(Crunch My Party), or clone across scenes (Multilevel Tokens).

**None of them treat "the party is in one place" as a fact the world knows.**
That is the idea worth proposing upstream — after we've run ours for a while.
