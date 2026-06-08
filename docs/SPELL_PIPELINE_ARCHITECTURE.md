# ACE QOL — Unified Spell Pipeline Architecture
**Author:** Claude (Anthropic), Johnny (sereptus-777)
**Drafted:** 2026-06-07
**Status:** Approved for build — pending Magic Missile migration as proof-of-concept
**Scope:** ACE QOL v0.7.17+ — replaces the current one-off spell handling in `spell-auto-damage.mjs`, the standalone `magic-missile-picker.mjs`, the legacy `spell-target-picker.mjs` Bless/Bane flow, and any other ad-hoc spell intercepts.

---

## 1. Why this exists

D&D 5e has ~500-700 distinct spells across PHB, SRD, XGtE, TCoE, and post-launch supplements. Implementing each spell as a hand-rolled hook + bespoke picker + custom damage card path would take a year and a half and produce inconsistent UX.

**The pipeline approach:** every spell falls into one of ~10 *shapes*. Each shape has a single dispatch path. Adding a new spell is adding a *data entry* to the registry, not writing new code.

**Tonight's Magic Missile fix (v0.7.17)** is the proof-of-concept for the "distribute" shape. It will be migrated into the registry as part of the build.

**RAW correctness:** the pipeline is edition-aware. 2014 and 2024 PHB differences are handled per-spell-entry via a `byEdition` field. The `rulesVersion` setting drives dispatch.

**Polish target:** every shape ships at "demo on a launch livestream" quality — proper dialogs, brand-consistent styling, animations triggered after target selection, slot consumption deferred until confirm, clean cancel behavior, GM + player UX both considered.

---

## 2. The 10 shapes

Every spell maps to exactly one shape. Shape determines the picker UI, the resolver, and the animation timing.

| # | Shape ID | Examples | Picker UI | Resolver |
|---|---|---|---|---|
| 1 | `self` | Mage Armor, Shield, Mirror Image, Foresight, Stoneskin, Greater Invisibility | None | Apply effect to caster |
| 2 | `attack-single` | Fire Bolt, Eldritch Blast, Inflict Wounds, Chromatic Orb | dnd5e's attack flow (no override) | Vanilla dnd5e + damage card |
| 3 | `save-single` | Hold Person, Disintegrate, Polymorph, Banishment, Charm Person | Single-pick portrait grid | Save card → effect on fail |
| 4 | `distribute` | Magic Missile, Scorching Ray, Eldritch Blast at L17 | +/− counter per target, total = N | Damage card with N-unit damage |
| 5 | `multi-buff` | Bless, Bane, Faerie Fire, Beacon of Hope, Slow, Aid | Multi-pick portrait grid, N max | Apply effect to each selected |
| 6 | `multi-heal` | Mass Cure Wounds, Mass Healing Word, Heroes' Feast | Multi-pick portrait grid, N max | Heal card with multi-target rows |
| 7 | `touch` | Cure Wounds, Lay on Hands, Vampiric Touch, Healing Word | Single-pick, adjacent-only | Heal card OR damage card |
| 8 | `template-save` | Fireball, Cone of Cold, Lightning Bolt, Stinking Cloud | dnd5e's template UI | Save card → damage per save result |
| 9 | `template-trigger` | Spike Growth, Cloud of Daggers, Wall of Fire, Moonbeam, Grease, Web | dnd5e's template UI | Persistent template + entry/movement triggers |
| 10 | `aura` | Spirit Guardians, Aura of Vitality, Crusader's Mantle, Holy Weapon | None | Caster-anchored emanation, per-turn re-eval |
| 11 | `summon` | Find Familiar, Animate Dead, Conjure Animals | Dialog to pick creature template | Spawn token(s) from compendium |
| 12 | `chained` | Chain Lightning (primary + 3 jumps), Sleep (HP-pool resolution) | Primary picker, then auto-resolve | Damage card with N rows, or condition application |

**Note:** shapes 2, 8, 9, 10, 11 mostly LET DND5E DO THE WORK and intercept only for polish/animation/edge cases. The pipeline doesn't reinvent attack rolls or template placement.

---

## 3. The registry — data, not code

The single source of truth for spell behavior. One entry per spell. Lookup is case-insensitive by item name.

### 3.1 — Schema (TypeScript-style for clarity, will be a JS object)

```typescript
interface SpellEntry {
  // ── Required ──────────────────────────────────────────
  shape: ShapeId;              // one of the 10+ shapes above
  range: number;               // feet; 0 = self, 5 = touch, Infinity = unlimited

  // ── Count / scaling ───────────────────────────────────
  // For multi-target shapes (distribute, multi-buff, multi-heal, chained):
  countResolver?: (castLevel: number, casterLevel: number) => number;

  // ── Damage shapes (distribute, template-save, attack-single overrides) ─
  unit?: {                     // For "distribute": per-unit damage (one dart)
    formula: string;           //   e.g. "1d4 + 1"
    type: string;              //   "force"
  };
  formula?: (castLvl: number, spellMod: number) => string;
  type?: string;               // damage type for shape-level formula
  halfOnSave?: boolean;        // template-save default behavior

  // ── Save shapes ───────────────────────────────────────
  save?: {
    ability: "str" | "dex" | "con" | "int" | "wis" | "cha";
    onFail: "effect" | "damage" | "both";
    onSuccess?: "half" | "negate";
  };

  // ── Buff / Heal shapes ────────────────────────────────
  effect?: {
    key: string;               // ACE effect identifier (e.g. "bless")
    icon?: string;             // optional override
    duration: "concentration" | "instantaneous" | { rounds?: number; minutes?: number };
  };
  heal?: {
    formula: (castLvl: number, spellMod: number) => string;
  };

  // ── Template shapes ───────────────────────────────────
  template?: {
    type: "circle" | "cone" | "line" | "square" | "wall";
    size: number;              // feet (cone length, line length, circle radius, etc.)
    width?: number;            // for lines/walls
  };

  // ── Picker behavior ───────────────────────────────────
  picker?: {
    allowSelf: boolean;
    preHighlightSelf?: boolean;
    creatureTypeFilter?: string;    // "humanoid", "undead", etc. (Hold Person, Animate Dead)
    excludeDead?: boolean;           // default true; false for Revivify, Raise Dead
    requiresAdjacent?: boolean;      // touch spells
    maxPerTarget?: number;           // distribute: cap per target
  };

  // ── Edition awareness ─────────────────────────────────
  byEdition?: {
    legacy?: Partial<SpellEntry>;   // 2014-specific overrides
    modern?: Partial<SpellEntry>;   // 2024-specific overrides
  };

  // ── Polish ────────────────────────────────────────────
  schoolIcon?: string;          // for picker header art
  flavorOnConfirm?: string;     // chat card subtitle
  customAnimation?: string;     // override AA's default mapping if needed
}
```

### 3.2 — Example entries

```js
SPELL_REGISTRY = {
  // ── Self ──
  "mage armor": {
    shape: "self",
    range: 0,
    effect: { key: "mage_armor", duration: { minutes: 480 } },  // 8 hours
  },

  "shield": {
    shape: "self",
    range: 0,
    effect: { key: "shield", duration: { rounds: 1 } },
  },

  // ── Distribute ──
  "magic missile": {
    shape: "distribute",
    range: 120,
    countResolver: castLvl => 3 + Math.max(0, castLvl - 1),
    unit: { formula: "1d4 + 1", type: "force" },
    picker: { allowSelf: false, excludeDead: true },
  },

  "scorching ray": {
    shape: "distribute",
    range: 120,
    countResolver: castLvl => 3 + Math.max(0, castLvl - 2),  // 3 at L2, +1 per upcast
    unit: { formula: "2d6", type: "fire" },
    picker: { allowSelf: false, excludeDead: true },
    byEdition: {
      legacy: { /* 2014 used attack rolls per ray */
        shape: "attack-single",  // route through dnd5e attack flow per ray
      },
    },
  },

  // ── Multi-buff ──
  "bless": {
    shape: "multi-buff",
    range: 30,
    countResolver: castLvl => 3 + Math.max(0, castLvl - 1),
    effect: {
      key: "bless",
      icon: "icons/magic/holy/yellow-beam-radiant-3.webp",
      duration: "concentration",
    },
    picker: { allowSelf: true, preHighlightSelf: true },
  },

  "bane": {
    shape: "multi-buff",
    range: 30,
    countResolver: castLvl => 3 + Math.max(0, castLvl - 1),
    effect: { key: "bane", duration: "concentration" },
    save: { ability: "cha", onSuccess: "negate" },  // applies effect only on failed save
    picker: { allowSelf: false },
  },

  // ── Touch ──
  "cure wounds": {
    shape: "touch",
    range: 5,
    heal: { formula: (castLvl, spellMod) => `${castLvl}d8 + ${spellMod}` },
    picker: { allowSelf: true, preHighlightSelf: true, requiresAdjacent: true },
  },

  // ── Single save ──
  "hold person": {
    shape: "save-single",
    range: 60,
    save: { ability: "wis", onFail: "effect" },
    effect: { key: "paralyzed", duration: "concentration" },
    picker: { allowSelf: false, creatureTypeFilter: "humanoid" },
  },

  // ── Template-save ──
  "fireball": {
    shape: "template-save",
    range: 150,
    template: { type: "circle", size: 20 },
    save: { ability: "dex", onSuccess: "half" },
    formula: castLvl => `${5 + castLvl}d6`,  // 8d6 at L3 + 1d6/upcast
    type: "fire",
    halfOnSave: true,
  },

  // ── Template-trigger (persistent area) ──
  "spike growth": {
    shape: "template-trigger",
    range: 150,
    template: { type: "circle", size: 20 },
    // Trigger config consumed by the existing concentration-widget
    // entry/move trigger system. Pipeline only places the template;
    // ongoing triggers continue to live in concentration-widget.
  },

  // ── Aura ──
  "spirit guardians": {
    shape: "aura",
    range: 0,  // caster-centered
    template: { type: "circle", size: 15 },  // emanation
    save: { ability: "wis", onSuccess: "half" },
    formula: castLvl => `${castLvl}d8`,
    type: "radiant",  // or necrotic by alignment
    // ace-qol's existing aura system in spell-auras.mjs handles per-turn re-eval
  },

  // ── Chained ──
  "chain lightning": {
    shape: "chained",
    range: 150,
    countResolver: castLvl => 3 + Math.max(0, castLvl - 6),  // 3 secondary jumps + 1/upcast
    formula: castLvl => "10d8",
    type: "lightning",
    save: { ability: "dex", onSuccess: "half" },
    // Picker: pick primary; secondaries auto-selected within 30ft of primary.
  },

  // ...80-ish entries for v1.0 launch.
}
```

### 3.3 — Registry file layout

```
ace-qol/scripts/spell-pipeline/
  └── registry/
      ├── _index.mjs          — exports merged SPELL_REGISTRY object
      ├── self-spells.mjs     — Mage Armor, Shield, Mirror Image, Stoneskin, ...
      ├── distribute-spells.mjs  — Magic Missile, Scorching Ray, ...
      ├── buff-spells.mjs     — Bless, Bane, Faerie Fire, Slow, Haste, ...
      ├── heal-spells.mjs     — Cure Wounds, Healing Word, Mass Cure Wounds, ...
      ├── save-spells.mjs     — Hold Person, Charm Person, Polymorph, ...
      ├── template-spells.mjs  — Fireball, Lightning Bolt, Cone of Cold, ...
      ├── trigger-spells.mjs  — Spike Growth, Cloud of Daggers, Wall of Fire, ...
      ├── aura-spells.mjs     — Spirit Guardians, Aura of Vitality, ...
      ├── chain-spells.mjs    — Chain Lightning, Sleep, ...
      └── summon-spells.mjs   — Find Familiar, Animate Dead, ...
```

Splitting by shape keeps each file ~10-30 entries. Easier to grep, easier to PR-review when adding new spells.

---

## 4. The pipeline class

### 4.1 — File: `ace-qol/scripts/spell-pipeline/pipeline.mjs`

```js
import { SPELL_REGISTRY } from "./registry/_index.mjs";
import { UnifiedSpellPicker } from "./picker.mjs";
import { DamageResolver } from "./resolvers/damage.mjs";
import { SaveResolver } from "./resolvers/save.mjs";
import { HealResolver } from "./resolvers/heal.mjs";
import { BuffResolver } from "./resolvers/buff.mjs";
import { TemplateResolver } from "./resolvers/template.mjs";
import { SelfResolver } from "./resolvers/self.mjs";
import { AnimationHelper } from "./animation.mjs";

export class SpellPipeline {
  static initialize() {
    // Pre-cast hook: decide whether to intercept
    Hooks.on("dnd5e.preUseActivity", SpellPipeline._preUse);

    // Post-card hook: most shapes execute here, after dnd5e has rendered its usage card
    Hooks.on("dnd5e.postCreateUsageMessage", SpellPipeline._postUse);

    console.log(`${MODULE_ID} | SpellPipeline online`);
  }

  static _getEntry(item) {
    if (!item || item.type !== "spell") return null;
    const name = String(item.name ?? "").trim().toLowerCase();
    const raw = SPELL_REGISTRY[name];
    if (!raw) return null;
    return SpellPipeline._applyEdition(raw);
  }

  static _applyEdition(entry) {
    const ed = game.settings.get("dnd5e", "rulesVersion") ?? "modern";
    const editionOverride = entry.byEdition?.[ed];
    if (!editionOverride) return entry;
    return { ...entry, ...editionOverride };  // shallow merge
  }

  static _preUse(activity, usageConfig, dialogConfig, messageConfig) {
    const item = activity?.item;
    const entry = SpellPipeline._getEntry(item);
    if (!entry) return;  // not in registry — fall through to dnd5e

    // ── Defer slot consumption ──
    // Slot consumed manually on picker-confirm; cancel = no slot lost.
    if (usageConfig?.consume?.spellSlot !== undefined) {
      activity._aceSlotDeferred = true;
      usageConfig.consume.spellSlot = false;
    }
  }

  static async _postUse(activity, message) {
    const item = activity?.item;
    const entry = SpellPipeline._getEntry(item);
    if (!entry) return;  // not ours

    const actor = item.actor;
    const castLevel = Number(activity?.usage?.spellLevel ?? item.system?.level ?? 1);
    const spellMod = actor?.system?.attributes?.spellmod ?? 0;

    try {
      // Dispatch by shape
      const ctx = { entry, item, actor, activity, castLevel, spellMod, message };
      switch (entry.shape) {
        case "self":            await SelfResolver.run(ctx); break;
        case "distribute":      await SpellPipeline._runPicker(ctx, "distribute"); break;
        case "multi-buff":      await SpellPipeline._runPicker(ctx, "multi"); break;
        case "multi-heal":      await SpellPipeline._runPicker(ctx, "multi"); break;
        case "save-single":     await SpellPipeline._runPicker(ctx, "single"); break;
        case "touch":           await SpellPipeline._runPicker(ctx, "single-adjacent"); break;
        case "template-save":   await TemplateResolver.runSave(ctx); break;
        case "template-trigger": await TemplateResolver.runTrigger(ctx); break;
        case "aura":            await TemplateResolver.runAura(ctx); break;
        case "chained":         await SpellPipeline._runPicker(ctx, "chained"); break;
        case "summon":          /* future */; break;
        case "attack-single":   /* fall through to dnd5e */; break;
        default:
          console.warn(`${MODULE_ID} | SpellPipeline: unknown shape "${entry.shape}" for ${item.name}`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | SpellPipeline dispatch failed for ${item?.name}:`, err);
      // On error, refund the deferred slot
      if (activity._aceSlotDeferred) SpellPipeline._refundSlot(activity, castLevel);
    }
  }

  static async _runPicker(ctx, pickerType) {
    const result = await UnifiedSpellPicker.pick({ ...ctx, pickerType });
    if (!result) {
      // Cancelled — refund slot, no card, return cleanly
      if (ctx.activity._aceSlotDeferred) SpellPipeline._refundSlot(ctx.activity, ctx.castLevel);
      ui.notifications?.info(`${ctx.item.name}: cancelled.`);
      return;
    }
    // Commit slot
    if (ctx.activity._aceSlotDeferred) await SpellPipeline._consumeSlot(ctx.activity, ctx.castLevel);

    // Route to resolver based on shape
    switch (ctx.entry.shape) {
      case "distribute":   await DamageResolver.runDistribute(ctx, result); break;
      case "multi-buff":   await BuffResolver.runMulti(ctx, result); break;
      case "multi-heal":   await HealResolver.runMulti(ctx, result); break;
      case "save-single":  await SaveResolver.runSingle(ctx, result); break;
      case "touch":        await SpellPipeline._dispatchTouch(ctx, result); break;
      case "chained":      await DamageResolver.runChained(ctx, result); break;
    }

    // Trigger Automated Animations with the resolved targets
    await AnimationHelper.play(ctx, result);
  }

  static async _consumeSlot(activity, castLevel) {
    // Manual slot consumption — mirrors dnd5e's internal logic
    const actor = activity?.item?.actor;
    if (!actor) return;
    const slotKey = castLevel === 0 ? "pact" : `spell${castLevel}`;
    const slot = actor.system?.spells?.[slotKey];
    if (slot && slot.value > 0) {
      await actor.update({ [`system.spells.${slotKey}.value`]: slot.value - 1 });
    }
  }

  static async _refundSlot(activity, castLevel) {
    // No-op if we never consumed (deferred + cancelled case is the common one).
    // Defensive helper for the error path only.
    activity._aceSlotDeferred = false;
  }

  static _dispatchTouch(ctx, result) {
    // Touch shape is either heal (Cure Wounds) or harm (Vampiric Touch).
    if (ctx.entry.heal) return HealResolver.runSingle(ctx, result);
    return DamageResolver.runSingle(ctx, result);
  }
}
```

---

## 5. The unified picker

### 5.1 — File: `ace-qol/scripts/spell-pipeline/picker.mjs`

ONE picker class. Dispatches UI based on `pickerType` arg.

```js
export class UnifiedSpellPicker {
  /**
   * @param {object} opts
   * @param {object} opts.entry         - registry entry
   * @param {Item} opts.item            - spell item
   * @param {Actor} opts.actor          - caster
   * @param {number} opts.castLevel
   * @param {number} opts.spellMod
   * @param {"single"|"single-adjacent"|"multi"|"distribute"|"chained"} opts.pickerType
   * @returns {Promise<{targets: Actor[], distribution?: Map<Actor, number>}|null>}
   */
  static async pick(opts) {
    const { entry, item, actor, castLevel, pickerType } = opts;

    // Build candidates (vision/cover/range-filtered)
    const candidates = await UnifiedSpellPicker._buildCandidates({
      actor,
      range: entry.range,
      filter: entry.picker ?? {},
    });

    if (!candidates.length) {
      ui.notifications?.warn(`${item.name}: no valid targets in range.`);
      return null;
    }

    // Compute N for shapes that need it
    const N = entry.countResolver?.(castLevel, actor.system?.details?.level ?? 1) ?? 1;

    // Pre-fill from game.user.targets (per Tuesday's decision)
    const preTargets = UnifiedSpellPicker._matchPreTargets(candidates);

    switch (pickerType) {
      case "single":
        return UnifiedSpellPicker._showSinglePicker({ ...opts, candidates, preTargets });
      case "single-adjacent":
        return UnifiedSpellPicker._showSinglePicker({ ...opts, candidates: UnifiedSpellPicker._filterAdjacent(candidates, actor), preTargets });
      case "multi":
        return UnifiedSpellPicker._showMultiPicker({ ...opts, candidates, preTargets, N });
      case "distribute":
        return UnifiedSpellPicker._showDistributePicker({ ...opts, candidates, preTargets, N });
      case "chained":
        return UnifiedSpellPicker._showSinglePicker({ ...opts, candidates, preTargets, chainedN: N });
    }
  }

  static async _buildCandidates({ actor, range, filter }) {
    const casterToken = actor.getActiveTokens?.()?.[0]
      ?? canvas.tokens?.placeables.find(t => t.actor?.id === actor.id)
      ?? null;
    if (!casterToken) return [];

    const placeables = canvas.tokens?.placeables ?? [];
    const out = [];
    for (const tok of placeables) {
      const tActor = tok.actor;
      if (!tActor) continue;
      const isSelf = tActor.id === actor.id;
      if (isSelf && !filter.allowSelf) continue;
      if (tok.document?.hidden && !game.user.isGM) continue;
      if (filter.excludeDead !== false) {
        const hp = tActor.system?.attributes?.hp?.value ?? 0;
        if (hp <= 0) continue;
      }
      if (filter.creatureTypeFilter) {
        const type = tActor.system?.details?.type?.value ?? "";
        if (type !== filter.creatureTypeFilter) continue;
      }

      const dist = UnifiedSpellPicker._distFt(casterToken, tok);
      const inRange = dist <= range || range === 0 && isSelf;
      const inLOS = UnifiedSpellPicker._checkLOS(casterToken, tok);  // strict-RAW per Tuesday's decision

      out.push({
        tokenId: tok.id,
        actor: tActor,
        token: tok,
        name: tok.name ?? tActor.name,
        img: tok.document?.texture?.src ?? tActor.img,
        ac: tActor.system?.attributes?.ac?.value ?? null,
        hp: tActor.system?.attributes?.hp?.value ?? 0,
        maxHP: tActor.system?.attributes?.hp?.max ?? 0,
        distFt: dist,
        inRange,
        inLOS,
        selectable: inRange && inLOS,
        isSelf,
        isNPC: tActor.type === "npc",
      });
    }
    // Sort: in-range selectable first, then OOR, then self
    out.sort((a, b) => {
      if (a.selectable !== b.selectable) return a.selectable ? -1 : 1;
      if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
      return a.distFt - b.distFt;
    });
    return out;
  }

  // ─── Picker UI variants ────────────────────────────────
  static _showSinglePicker(opts) { /* portrait grid, click one */ }
  static _showMultiPicker(opts)  { /* portrait grid, click N */ }
  static _showDistributePicker(opts) { /* +/− counters per portrait, total = N */ }

  // ─── Helpers ───────────────────────────────────────────
  static _distFt(t1, t2) {
    const distPx = Math.hypot(
      (t2.center?.x ?? t2.x) - (t1.center?.x ?? t1.x),
      (t2.center?.y ?? t2.y) - (t1.center?.y ?? t1.y),
    );
    const gridSize = canvas.scene?.grid?.size ?? 100;
    const gridDistance = canvas.scene?.grid?.distance ?? 5;
    return Math.round((distPx / gridSize) * gridDistance);
  }

  static _checkLOS(casterToken, targetToken) {
    // Strict RAW per Tuesday's decision. Use Foundry's vision API.
    // Returns true if caster has line-of-sight to target's center.
    if (!canvas.walls) return true;
    const ray = new Ray(casterToken.center, targetToken.center);
    return !canvas.walls.checkCollision(ray, { type: "sight" });
  }

  static _matchPreTargets(candidates) {
    const targeted = new Set([...(game.user.targets ?? [])].map(t => t.id));
    return new Set(candidates.filter(c => targeted.has(c.tokenId)).map(c => c.tokenId));
  }

  static _filterAdjacent(candidates, actor) {
    const casterToken = actor.getActiveTokens?.()?.[0];
    if (!casterToken) return candidates;
    return candidates.filter(c => c.distFt <= 5);
  }
}
```

**Visual style:** all picker variants share the dark-wrapper ACE branding (from `magic-missile-picker.mjs` tonight — inline-styled, bulletproof against DialogV2 CSS-stripping). Portrait size **56×56**. Row height tight. Confirm button disabled until selection meets shape requirements.

---

## 6. The resolvers

Each resolver is a small class that takes `(ctx, pickerResult)` and produces the appropriate chat card.

### 6.1 — `resolvers/damage.mjs`

- `runDistribute(ctx, distribution)` — Magic Missile, Scorching Ray. Builds `mmHits` array with per-target dart count + per-unit formula + Empowered Evocation on first hit. Calls `DamageCardRenderer.postDamageButton(item, actor, hits)`.
- `runSingle(ctx, target)` — Vampiric Touch, single-target damage spells. Same renderer.
- `runChained(ctx, primary)` — Chain Lightning. Finds 3 (or N) closest enemies within 30ft of primary, posts damage card with 1+N target rows.

### 6.2 — `resolvers/save.mjs`

- `runSingle(ctx, target)` — Hold Person, Disintegrate. Routes to existing `SaveEngine._postSaveCard(item, actor, [target], saveAbility)`. On fail, applies effect from entry.

### 6.3 — `resolvers/heal.mjs`

- `runSingle(ctx, target)` — Cure Wounds. Calls existing `HealCardRenderer.post(item, actor, [target], formula)`.
- `runMulti(ctx, targets)` — Mass Cure Wounds. Multi-row heal card.

### 6.4 — `resolvers/buff.mjs`

- `runMulti(ctx, targets)` — Bless, Faerie Fire. For each target, applies an `ActiveEffect` with the entry's `effect.key`. Effect details come from `extended-effects.mjs`'s key registry. Concentration registered on caster if `duration === "concentration"`.

### 6.5 — `resolvers/template.mjs`

- `runSave(ctx)` — Fireball. Lets dnd5e place the template (template-placement UI is already great). Hooks on `createMeasuredTemplate`, collects tokens inside, posts save card, on save-result computes damage per target.
- `runTrigger(ctx)` — Spike Growth, Cloud of Daggers. Places template, registers with existing `concentration-widget` entry/movement trigger system.
- `runAura(ctx)` — Spirit Guardians. Anchors emanation to caster, registers with existing `spell-auras.mjs`.

### 6.6 — `resolvers/self.mjs`

- `run(ctx)` — Mage Armor, Shield. Applies `effect` to caster directly. No picker.

---

## 7. Animation integration

After picker confirms (and resolver runs), `AnimationHelper.play(ctx, result)`:

```js
export class AnimationHelper {
  static async play(ctx, result) {
    try {
      const aa = globalThis.AutomatedAnimations ?? window.AutomatedAnimations;
      if (!aa?.playAnimation) return;

      const casterToken = ctx.actor.getActiveTokens?.()?.[0]
        ?? canvas.tokens?.placeables.find(t => t.actor?.id === ctx.actor.id);
      if (!casterToken) return;

      // AA reads game.user.targets — set them to the resolved targets
      const targets = AnimationHelper._extractTargets(result);
      if (targets.length > 0) {
        await game.user.updateTokenTargets(targets.map(t => t.id));
      }

      // Custom override or AA's default mapping
      if (ctx.entry.customAnimation) {
        // future: directly invoke Sequencer with a custom path
      }
      aa.playAnimation(casterToken, ctx.item);
    } catch (err) {
      console.warn(`${MODULE_ID} | AnimationHelper failed (non-fatal):`, err);
    }
  }

  static _extractTargets(result) {
    if (result?.targets) return result.targets.map(t => t.token).filter(Boolean);
    if (result?.distribution) return [...result.distribution.keys()].map(a => a.getActiveTokens?.()?.[0]).filter(Boolean);
    if (result?.target) return [result.target.token].filter(Boolean);
    return [];
  }
}
```

---

## 8. Integration with existing code

What goes away, what stays.

### 8.1 — Removed / replaced
- **`spell-auto-damage.mjs` Magic Missile fork** — entire `_isMagicMissile` block and `_handleDamageSpell`'s Magic Missile branch deleted. Magic Missile now flows through pipeline.
- **`magic-missile-picker.mjs`** — kept temporarily for the inline-style portrait grid CSS. The styling moves into `picker.mjs`'s distribute variant. File can be deleted once migrated.
- **`spell-target-picker.mjs`** — Bless/Bane picker. Its CSS + portrait-grid logic migrates into `picker.mjs`'s multi variant. File deleted.
- **`spell-auto-damage.mjs`'s broader `_isAutoHitDamageSpell` filter** — generalized to "is this in the registry?" check. The old filter stays as a safety net for spells not yet in the registry.

### 8.2 — Modified
- **`engagement-gate.mjs`** — adds a check: if spell is in `SPELL_REGISTRY`, bypass the "select a target first" block. Pipeline owns targeting.
- **`damage-card-renderer.mjs`** — no changes required, it already handles the `magicMissileOverride` per-target shape. Future shapes may add similar overrides.
- **`save-engine.mjs`** — gets a new entry point for pipeline-routed saves. Existing dnd5e-triggered save flow unchanged.
- **`heal-card-renderer.mjs`** — gets a multi-target variant if it doesn't have one.
- **`extended-effects.mjs`** — buff resolver consults this for effect-key configurations. May need additional keys added per spell.

### 8.3 — Unchanged
- **`weapon-masteries.mjs`** — independent system for weapons. Not in pipeline scope.
- **`attack-pipeline.mjs`** — handles attack rolls. Spells with `shape: "attack-single"` fall through to it.
- **`concentration-widget.mjs`** — receives template-trigger spells, no changes to the widget itself.
- **`spell-auras.mjs`** — receives aura-shape spells, no changes.
- **`reaction-engine.mjs`** — Counterspell etc. continue to live here. Spells routed via the pipeline still trigger reaction prompts upstream of pipeline dispatch.

---

## 9. Build order (proposed)

### Phase 1 — Foundation (~6-8 hr, ONE FOCUSED SESSION)

1. Create `spell-pipeline/` folder structure
2. Write `pipeline.mjs` (main class, hooks, dispatch)
3. Write `picker.mjs` (unified picker with all 4 UI variants, inline-styled)
4. Write `registry/_index.mjs` + skeleton shape files (mostly empty stubs)
5. Write each resolver (damage, save, heal, buff, template, self) — each ~40-80 lines
6. Write `animation.mjs`
7. Wire `engagement-gate.mjs` registry bypass
8. Hook registration in `ace-qol.mjs` init
9. Register `gameRulesEdition` reads in `_applyEdition`
10. **MIGRATE MAGIC MISSILE** into `registry/distribute-spells.mjs` as proof-of-concept
11. Delete the Magic Missile fork from `spell-auto-damage.mjs`
12. Test: cast Magic Missile → picker → animation → damage card → APPLY ALL

**Definition of done for Phase 1:** Magic Missile works identically to v0.7.17 but through the registry. No regression. Animation fires after picker. Slot deferred. Cancel = no slot lost.

### Phase 2 — Most-cast spells (~10-15 hr, can split across 2-3 sessions)

Order by frequency of play. Each entry takes 5-15 min once the pipeline is solid.

1. **Buffs**: Bless, Bane, Faerie Fire, Shield of Faith, Aid (5 entries)
2. **Self-buffs**: Mage Armor, Shield, Mirror Image, Stoneskin, Blur, Greater Invisibility (6 entries)
3. **Healing**: Cure Wounds, Healing Word, Mass Cure Wounds, Mass Healing Word, Heal (5 entries)
4. **Touch damage**: Vampiric Touch, Inflict Wounds (2 entries)
5. **Single save**: Hold Person, Charm Person, Banishment, Polymorph, Disintegrate, Dominate Person, Feeblemind (7 entries)
6. **Template save**: Fireball, Cone of Cold, Lightning Bolt, Stinking Cloud, Sleet Storm, Ice Storm, Sunburst (7 entries)
7. **Template trigger**: Spike Growth, Cloud of Daggers, Wall of Fire, Wall of Stone, Moonbeam, Grease, Web, Black Tentacles (8 entries)
8. **Auras**: Spirit Guardians, Aura of Vitality, Crusader's Mantle, Holy Weapon, Elemental Weapon (5 entries)
9. **Distribute (besides Magic Missile)**: Scorching Ray (1 entry; Eldritch Blast at L17 is conditional)
10. **Smites**: Divine Smite, Wrathful Smite, Searing Smite, Thunderous Smite, Blinding Smite, Staggering Smite, Banishing Smite (7 entries)

**Total Phase 2 launch scope:** ~53 spells. Combined with Magic Missile = 54. Covers ~95% of actual table casts.

### Phase 3 — Long-tail (post-launch, ongoing)

Remaining ~200+ less-common spells. Add as players cast them. Each one is 5-10 minutes.

---

## 10. Edge cases and decisions

### 10.1 — Slot deferral details
- Pre-cast hook sets `usageConfig.consume.spellSlot = false` and a marker on the activity.
- Post-card hook (where pipeline dispatches) reads the marker.
- On confirm: manually consume one slot of `castLevel` via `actor.update`.
- On cancel: no action — marker stays false, slot never consumed.
- On dispatch error: log + leave slot alone (already not consumed).
- **Pact slots** for Warlock: `pact` instead of `spell{N}` — handle in `_consumeSlot`.

### 10.2 — Concentration prompt timing
- If caster already concentrating and the new spell requires concentration, prompt BEFORE the picker opens.
- Cancel here = no slot consumed (slot was already deferred), no replacement of concentration.
- Pattern: in `_postUse`, before dispatch, call `ConcentrationManager.checkReplace(actor, item)`.

### 10.3 — Reaction prompts
- Counterspell etc. fire at the dnd5e level, BEFORE `postCreateUsageMessage`. So the reaction-engine already runs upstream of the pipeline.
- If a spell is countered, dnd5e bails before pipeline dispatch. Our slot is still in "deferred" state — no slot lost, correct behavior.

### 10.4 — Empowered Evocation, Potent Spellcasting, Agonizing Blast
- These class features add bonus damage to specific spell categories.
- They live in `combat-state.mjs` / `damage-calculator.mjs` (existing). Pipeline doesn't reinvent them.
- DamageResolver passes the spell item + caster through to DamageCardRenderer, which already runs the class-feature riders correctly.

### 10.5 — Cantrip scaling
- Cantrips scale by character level, not slot level.
- The `formula(castLvl, spellMod)` callback receives `castLvl = 0` for cantrips. The function should branch on cantrip behavior internally:
  - `(castLvl, spellMod) => castLvl === 0 ? this._cantripFormula(actor) : `${castLvl}d8 + ${spellMod}``
- Helper: `entry.cantripScaling: (charLevel) => dieCount`.

### 10.6 — Spell scrolls and macro-fired spells
- Spell scrolls go through `Item.use()` with the spell item. Pipeline catches via the same hooks.
- Programmatic `item.use()` calls (macros, sequencer chains) trigger the same hooks. Pipeline handles them identically.
- If `preUseActivity` does not fire (rare hook-skip case), pipeline falls through to dnd5e gracefully. No crash.

### 10.7 — Homebrew spells with same name as registry entries
- If the GM has a homebrew "Fireball" with a different formula, the registry's hard-coded formula wins.
- **Future enhancement**: registry could read the spell's own damage parts as the formula source, with the registry providing only the shape/template/save info. Deferred to post-launch.

### 10.8 — Spells the registry doesn't cover
- Pipeline returns null → dnd5e default flow runs unchanged.
- This is the safe failure mode. Any spell not yet migrated still works exactly as it does today.

---

## 11. Testing strategy

For each spell migrated into the registry:

1. **Cast with no targets selected** → picker opens, candidates listed, range-color correct
2. **Cast with pre-targets** → picker pre-fills from `game.user.targets`
3. **Cast and cancel** → no slot lost, no chat card, picker dismisses cleanly
4. **Cast and confirm** → slot consumed, animation fires, damage/effect applied
5. **Cast with out-of-range target highlighted in user targets** → picker shows dimmed but greys confirm
6. **Cast with concentration active** → replace prompt fires before picker
7. **2014 + 2024 editions** — verify edition-specific behavior where applicable
8. **GM cast vs player cast** — both work, permission gates respected

A test checklist will live alongside the registry: `docs/SPELL_TESTING_CHECKLIST.md`.

---

## 12. Files created / changed (Phase 1 summary)

### Created
- `scripts/spell-pipeline/pipeline.mjs`
- `scripts/spell-pipeline/picker.mjs`
- `scripts/spell-pipeline/animation.mjs`
- `scripts/spell-pipeline/registry/_index.mjs`
- `scripts/spell-pipeline/registry/distribute-spells.mjs` (Magic Missile)
- `scripts/spell-pipeline/registry/self-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/buff-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/heal-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/save-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/template-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/trigger-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/aura-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/chain-spells.mjs` (stub)
- `scripts/spell-pipeline/registry/summon-spells.mjs` (stub)
- `scripts/spell-pipeline/resolvers/damage.mjs`
- `scripts/spell-pipeline/resolvers/save.mjs`
- `scripts/spell-pipeline/resolvers/heal.mjs`
- `scripts/spell-pipeline/resolvers/buff.mjs`
- `scripts/spell-pipeline/resolvers/template.mjs`
- `scripts/spell-pipeline/resolvers/self.mjs`

### Modified
- `scripts/ace-qol.mjs` — register `SpellPipeline.initialize()` in init
- `scripts/spell-auto-damage.mjs` — remove Magic Missile fork, keep general auto-damage filter as fallback for spells not yet in registry
- `scripts/engagement-gate.mjs` — replace `_isMagicMissile` bypass with general `SpellPipeline._getEntry()` bypass

### Deleted (after Phase 1 verification)
- `scripts/magic-missile-picker.mjs` (CSS migrates to picker.mjs)
- `scripts/spell-target-picker.mjs` (CSS migrates to picker.mjs)

---

## 13. Decisions locked (from Tuesday + tonight)

1. **Pre-fill from game.user.targets** in all multi-pick / distribute / single-pick variants
2. **Defer slot consumption** until picker confirm
3. **Strict-RAW LOS** — caster can't see target → not selectable (greyed in picker, blocked from selection)
4. **Pre-highlight self** for spells with `allowSelf: true && preHighlightSelf: true`
5. **Animation fires AFTER picker confirms** via `AutomatedAnimations.playAnimation` with `game.user.targets` set to the resolved targets
6. **Edition-aware** via `byEdition: { legacy, modern }` per entry, dispatched by `game.settings.get("dnd5e", "rulesVersion")`
7. **Polish bar:** inline-styled bulletproof CSS, 56×56 portraits, no tradeoffs offered to user, ship at "demo on a launch livestream" quality (CLAUDE.md principle 7)

---

## 14. Open questions (resolve during Phase 1 build, not before)

1. **Cantrip-only resolver?** Or fold into existing shapes with `cantripScaling`? Lean: fold in.
2. **Wild Magic / Sorcery Points / Metamagic** — do these need pipeline hooks, or do they remain client-side at the dnd5e activity level? Lean: dnd5e handles them; pipeline reads the final cast level.
3. **Ritual casting** — slot deferral logic for rituals (no slot consumed). Lean: detect ritual flag, skip slot consumption entirely.
4. **Counterspell-of-a-counterspell** chains — reaction-engine already handles this at the reaction level. Pipeline doesn't see it.
5. **Spell-scroll consumption** — separate from slot consumption (scroll is destroyed instead). Need a parallel "deferred consume" pattern for scrolls. Lean: phase 2 polish.

---

## 15. Glossary

- **Shape** — the architectural classification of a spell (e.g. `distribute`, `multi-buff`)
- **Registry** — the central data table mapping spell names to shape + behavior
- **Pipeline** — the dispatcher class that hooks dnd5e and routes spells to shapes
- **Picker** — the targeting UI (single/multi/distribute variants)
- **Resolver** — the per-shape effect applier (damage card, heal card, effect application)
- **Edition** — `legacy` (2014) or `modern` (2024) per `dnd5e.rulesVersion`
- **Deferred slot** — slot consumption postponed until picker confirms, refunded on cancel
- **Strict-RAW LOS** — line of sight enforced per RAW; caster must see target to select it
- **Q-targets** — informal shorthand for `game.user.targets` (pre-targeted tokens before cast)

---

**End of architecture doc.** Phase 1 build is the next focused session. Magic Missile migrates in as the proof. Then Bless. Then the rest of the 54-spell launch scope.
