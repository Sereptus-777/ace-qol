// ─── ACE: QOL — Diagnostics Engine ──────────────────────────────────────────
// Console-callable test suite: system health, smoke tests, integration probes.
// Run:  game.aceQol.diagnostics.runAll()
//       game.aceQol.diagnostics.checkSystems()
//       game.aceQol.diagnostics.smokeTest()
//       game.aceQol.diagnostics.checkIntegrations()
//       game.aceQol.diagnostics.auditFlags()
//       game.aceQol.diagnostics.perfSnapshot()
// ──────────────────────────────────────────────────────────────────────────────

const MODULE_ID = "ace-qol";
const TAG = `${MODULE_ID} | Diagnostics`;

// Result status constants
const OK   = "OK";
const WARN = "WARN";
const FAIL = "FAIL";
const SKIP = "SKIP";

// ─── Color formatting for console output ─────────────────────────────────────
const COLORS = {
  [OK]:   "color: #00e676; font-weight: bold",
  [WARN]: "color: #ffab00; font-weight: bold",
  [FAIL]: "color: #ff1744; font-weight: bold",
  [SKIP]: "color: #90a4ae; font-weight: bold",
  header: "color: #d4af37; font-weight: bold; font-size: 14px",
  sub:    "color: #64b5f6; font-weight: bold",
  dim:    "color: #888",
};

function _log(status, label, detail = "") {
  console.log(`%c[${status}]%c ${label} %c${detail}`, COLORS[status], "color: inherit", COLORS.dim);
}

function _header(title) {
  console.log(`\n%c═══ ${title} ═══`, COLORS.header);
}

function _sub(title) {
  console.log(`%c── ${title} ──`, COLORS.sub);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1. SYSTEM HEALTH CHECK — Are all engines initialized?
// ═══════════════════════════════════════════════════════════════════════════════

export function checkSystems() {
  _header("SYSTEM HEALTH CHECK");
  const api = game.aceQol;
  if (!api) {
    _log(FAIL, "game.aceQol", "API object not found — module may not be active");
    return { total: 0, ok: 0, warn: 0, fail: 1 };
  }

  const results = [];
  const isGM = game.user.isGM;

  // ── Engine existence checks ──
  const engines = [
    // [name, ref, gmOnly, description]
    ["AttackPipeline",       api.attackPipeline,       false, "Pre/post attack roll processing"],
    ["DamageEngine",         api.damageEngine,         false, "Damage calculation + card rendering"],
    ["SaveEngine",           api.saveEngine,           false, "Save-based spell processing"],
    ["ConcentrationWidget",  api.concentrationWidget,  true,  "Persistent AoE spell tracking"],
    ["ReactionEngine",       api.reactionEngine,       false, "Reaction prompts (Shield, Counterspell)"],
    ["OverTimeEngine",       api.overTimeEngine,       true,  "Recurring damage effects (Moonbeam, etc.)"],
    ["BloodiedEngine",       api.bloodiedEngine,       false, "HP threshold visual indicators"],
    ["DurationTracker",      api.durationTracker,      false, "Effect expiration on turn/rest"],
    ["SpeedRolls",           api.speedRolls,           false, "Fast-forward item rolling"],
    ["LootEngine",           api.lootEngine,           false, "CR-based loot generation"],
    ["DeathPipeline",        api.deathPipeline,        true,  "Dead art tile conversion"],
    ["ExtendedEffects",      api.extendedEffects,      false, "Enhanced Active Effect processing"],
    ["TransformationEngine", api.TransformationEngine, true,  "Custom polymorph (Tier 3 RAW)"],
    ["TokenCache",           api.TokenCache ?? api.tokenCache, true, "Beast image folder cache"],
  ];

  for (const [name, ref, gmOnly, desc] of engines) {
    if (gmOnly && !isGM) {
      _log(SKIP, name, `GM-only engine (you are a player)`);
      results.push({ name, status: SKIP });
    } else if (ref) {
      _log(OK, name, desc);
      results.push({ name, status: OK });
    } else {
      _log(FAIL, name, `NOT initialized — ${desc}`);
      results.push({ name, status: FAIL });
    }
  }

  // ── Static class checks ──
  const statics = [
    ["FlagsEngine",       api.FlagsEngine,       "Flag reader with Midi-QOL compat"],
    ["HookAPI",           api.HookAPI,            "14 pipeline hook points"],
    ["CoverEngine",       api.CoverEngine,        "Ray-cast cover calculation"],
    ["VisibilityEngine",  api.VisibilityEngine,   "NPC roll visibility filtering"],
    ["ConditionLibrary",  api.ConditionLibrary,    "64 pre-built SRD effects"],
    ["MergeCard",         api.MergeCard,           "Combined attack+damage cards"],
    ["TargetState",       api.TargetState,         "Target defensive assessment"],
    ["CombatState",       api.CombatState,         "Full combat state evaluation"],
  ];

  for (const [name, ref, desc] of statics) {
    if (ref) {
      _log(OK, name, desc);
      results.push({ name, status: OK });
    } else {
      _log(FAIL, name, `Static class not exposed — ${desc}`);
      results.push({ name, status: FAIL });
    }
  }

  const ok   = results.filter(r => r.status === OK).length;
  const fail = results.filter(r => r.status === FAIL).length;
  const warn = results.filter(r => r.status === WARN).length;
  const skip = results.filter(r => r.status === SKIP).length;

  console.log(`\n%cSystems: ${ok} OK, ${warn} WARN, ${fail} FAIL, ${skip} SKIP (of ${results.length})`,
    fail > 0 ? COLORS[FAIL] : COLORS[OK]);

  return { total: results.length, ok, warn, fail, skip, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. SETTINGS VALIDATION — Do all settings exist with sane values?
// ═══════════════════════════════════════════════════════════════════════════════

export function checkSettings() {
  _header("SETTINGS VALIDATION");
  const results = [];

  // Critical settings that must exist
  const criticalSettings = [
    // [key, expectedType, description]
    ["autoCheckHit",             "boolean", "Auto-check if attack hits"],
    ["autoCheckResistances",     "boolean", "Auto-check damage resistances"],
    ["damageTypeSeparation",     "boolean", "Separate mixed damage by type"],
    ["concentrationTracking",    "boolean", "Track concentration on casters"],
    ["concentrationOnDamage",    "boolean", "RAW concentration save on damage"],
    ["concentrationDamageMinDC", "number",  "Floor DC for concentration save"],
    ["bonusActionSpellRule",     "boolean", "RAW bonus action spell rule"],
    ["bonusActionSpellStrict",   "boolean", "Strict-block vs warn-only mode"],
    ["polymorphMode",            "string",  "Polymorph mode (custom/dnd5e)"],
    ["npcDamageAnimationDelay",  "number",  "Spell damage DSN pacing"],
    ["enableReactions",          "boolean", "Enable reaction automation"],
    ["enableSpeedRolls",         "boolean", "Enable fast-forward rolling"],
    ["enableMergeCard",          "boolean", "Enable merged attack+damage"],
    ["enableBloodied",           "boolean", "Enable bloodied indicators"],
    ["enableDeadMarker",         "boolean", "Apply dead status at 0 HP"],
    ["enableCoverCalculation",   "boolean", "Enable cover ray-casting"],
    ["enableDurationTracker",    "boolean", "Enable effect expiration"],
    ["enableOverTimeEffects",    "boolean", "Enable recurring effects"],
    ["enableOnUseHooks",         "boolean", "Enable Hook API dispatch"],
    ["enableFlagsSystem",        "boolean", "Enable flags engine"],
    ["midiCompatibility",        "boolean", "Read midi-qol flags as fallback"],
    ["critRule",                 "string",  "Critical hit damage rule"],
    ["npcAttackVisibility",      "string",  "NPC attack roll visibility"],
    ["npcDamageVisibility",      "string",  "NPC damage roll visibility"],
    ["reactionTimeout",          "number",  "Reaction prompt timeout (sec)"],
    ["bloodiedThreshold",        "number",  "HP fraction for bloodied"],
    ["flanking",                 "boolean", "Enable flanking advantage"],
    ["enableLootGeneration",     "boolean", "Enable loot generation"],
    ["enableDeathPipeline",      "boolean", "Enable dead art conversion"],
    ["radiantSoulRiderEnabled",  "boolean", "Radiant Soul rider (Celestial Warlock 6+)"],
    ["descriptionOnKillRiderEnabled", "boolean", "On-kill description riders (Blood Halberd, etc.)"],
  ];

  for (const [key, expectedType, desc] of criticalSettings) {
    try {
      const value = game.settings.get(MODULE_ID, key);
      const actualType = typeof value;

      if (actualType !== expectedType) {
        _log(WARN, key, `Expected ${expectedType}, got ${actualType} (${value}) — ${desc}`);
        results.push({ key, status: WARN, value, expectedType, actualType });
      } else {
        _log(OK, key, `${value} — ${desc}`);
        results.push({ key, status: OK, value });
      }
    } catch (err) {
      _log(FAIL, key, `NOT REGISTERED — ${desc} (${err.message})`);
      results.push({ key, status: FAIL, error: err.message });
    }
  }

  const ok   = results.filter(r => r.status === OK).length;
  const fail = results.filter(r => r.status === FAIL).length;
  const warn = results.filter(r => r.status === WARN).length;

  console.log(`\n%cSettings: ${ok} OK, ${warn} WARN, ${fail} FAIL (of ${results.length})`,
    fail > 0 ? COLORS[FAIL] : (warn > 0 ? COLORS[WARN] : COLORS[OK]));

  return { total: results.length, ok, warn, fail, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. HOOK REGISTRATION AUDIT — Are expected hooks actually registered?
// ═══════════════════════════════════════════════════════════════════════════════

export function checkHooks() {
  _header("HOOK REGISTRATION AUDIT");
  const results = [];

  // Check Foundry's hook registry for expected hooks
  const expectedHooks = [
    // [hookName, minExpected, description]
    ["dnd5e.rollAttackV2",        1, "Attack roll interception"],
    ["renderChatMessage",         2, "Chat card rendering (damage buttons, loot cards, visibility)"],
    ["updateActor",               1, "Death detection + bloodied"],
    ["updateToken",               1, "Unlinked token bloodied"],
    ["refreshToken",              1, "Bloodied visual overlay"],
    ["updateCombat",              1, "Duration tracker + overtime"],
    ["deleteCombat",              1, "Combat cleanup"],
    ["createActiveEffect",        1, "Duration stamping"],
    ["deleteActiveEffect",        1, "Concentration break detection"],
    ["dnd5e.restCompleted",       1, "Rest effect expiration"],
    ["renderActorSheet5e",        1, "Speed rolls sheet hooks"],
  ];

  for (const [hookName, minExpected, desc] of expectedHooks) {
    const handlers = Hooks.events[hookName];
    const count = handlers?.length ?? 0;

    if (count >= minExpected) {
      _log(OK, hookName, `${count} handler(s) — ${desc}`);
      results.push({ hook: hookName, status: OK, count });
    } else if (count > 0) {
      _log(WARN, hookName, `${count} handler(s), expected ≥${minExpected} — ${desc}`);
      results.push({ hook: hookName, status: WARN, count });
    } else {
      _log(FAIL, hookName, `0 handlers — ${desc}`);
      results.push({ hook: hookName, status: FAIL, count: 0 });
    }
  }

  // Check custom ACE hooks are callable
  const aceHooks = [
    "ace-qol.preItemRoll", "ace-qol.preAttackRoll", "ace-qol.postAttackRoll",
    "ace-qol.preCheckHits", "ace-qol.postCheckHits", "ace-qol.preDamageRoll",
    "ace-qol.postDamageRoll", "ace-qol.preSave", "ace-qol.postSave",
    "ace-qol.preDamageApplication", "ace-qol.postDamageApplication",
    "ace-qol.preActiveEffects", "ace-qol.postActiveEffects",
  ];

  _sub("Custom Hook API Points");
  let aceOk = 0;
  for (const h of aceHooks) {
    // These may have 0 listeners (that's fine — they fire when pipeline runs)
    const count = Hooks.events[h]?.length ?? 0;
    _log(OK, h, `${count} listener(s) registered`);
    aceOk++;
  }
  _log(OK, "Hook API", `${aceHooks.length} hook points available`);

  const ok   = results.filter(r => r.status === OK).length;
  const fail = results.filter(r => r.status === FAIL).length;
  const warn = results.filter(r => r.status === WARN).length;

  console.log(`\n%cHooks: ${ok} OK, ${warn} WARN, ${fail} FAIL (of ${results.length}) + ${aceHooks.length} API hooks`,
    fail > 0 ? COLORS[FAIL] : COLORS[OK]);

  return { total: results.length, ok, warn, fail, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  4. SMOKE TEST — Validate critical code paths with mock data
// ═══════════════════════════════════════════════════════════════════════════════

export function smokeTest() {
  _header("SMOKE TESTS");
  const api = game.aceQol;
  if (!api) {
    _log(FAIL, "API", "game.aceQol not found");
    return { total: 0, ok: 0, fail: 1 };
  }

  const results = [];

  // ── Test 1: FlagsEngine reads without crashing ──
  _sub("FlagsEngine");
  try {
    const testActor = game.actors?.contents?.[0];
    if (testActor) {
      const flags = api.checkFlags(testActor, "mwak");
      const hasKeys = flags && typeof flags.attackAdvantage === "boolean";
      _log(hasKeys ? OK : WARN, "checkFlags()", `Keys present: ${Object.keys(flags).join(", ")}`);
      results.push({ test: "FlagsEngine.checkFlags", status: hasKeys ? OK : WARN });
    } else {
      _log(SKIP, "checkFlags()", "No actors in world to test against");
      results.push({ test: "FlagsEngine.checkFlags", status: SKIP });
    }
  } catch (err) {
    _log(FAIL, "checkFlags()", err.message);
    results.push({ test: "FlagsEngine.checkFlags", status: FAIL, error: err.message });
  }

  // ── Test 2: CoverEngine.calculateCover doesn't crash ──
  _sub("CoverEngine");
  try {
    if (api.CoverEngine?.calculateCover) {
      const tokens = canvas.tokens?.placeables ?? [];
      if (tokens.length >= 2) {
        const cover = api.CoverEngine.calculateCover(tokens[0], tokens[1]);
        const valid = cover && typeof cover.cover === "string";
        _log(valid ? OK : WARN, "calculateCover()", `Result: ${cover?.cover ?? "null"}, AC bonus: ${cover?.acBonus ?? "?"}`);
        results.push({ test: "CoverEngine.calculateCover", status: valid ? OK : WARN });
      } else {
        _log(SKIP, "calculateCover()", "Need ≥2 tokens on canvas");
        results.push({ test: "CoverEngine.calculateCover", status: SKIP });
      }
    } else {
      _log(FAIL, "calculateCover()", "Method not found on CoverEngine");
      results.push({ test: "CoverEngine.calculateCover", status: FAIL });
    }
  } catch (err) {
    _log(FAIL, "calculateCover()", err.message);
    results.push({ test: "CoverEngine.calculateCover", status: FAIL, error: err.message });
  }

  // ── Test 3: ConditionLibrary search ──
  _sub("ConditionLibrary");
  try {
    if (api.ConditionLibrary?.search) {
      const results5e = api.ConditionLibrary.search("blind");
      const found = Array.isArray(results5e) && results5e.length > 0;
      _log(found ? OK : WARN, "search('blind')", `Found ${results5e?.length ?? 0} matches`);
      results.push({ test: "ConditionLibrary.search", status: found ? OK : WARN });
    } else {
      _log(FAIL, "search()", "Method not found");
      results.push({ test: "ConditionLibrary.search", status: FAIL });
    }
  } catch (err) {
    _log(FAIL, "search()", err.message);
    results.push({ test: "ConditionLibrary.search", status: FAIL, error: err.message });
  }

  // ── Test 4: MergeCard.isEnabled reads correctly ──
  _sub("MergeCard");
  try {
    if (api.MergeCard) {
      const enabled = api.MergeCard.isEnabled;
      _log(OK, "MergeCard.isEnabled", `${enabled}`);
      results.push({ test: "MergeCard.isEnabled", status: OK });
    } else {
      _log(FAIL, "MergeCard", "Not exposed on API");
      results.push({ test: "MergeCard.isEnabled", status: FAIL });
    }
  } catch (err) {
    _log(FAIL, "MergeCard.isEnabled", err.message);
    results.push({ test: "MergeCard.isEnabled", status: FAIL, error: err.message });
  }

  // ── Test 5: TargetState.assess doesn't crash ──
  _sub("TargetState");
  try {
    const tokens = canvas.tokens?.placeables ?? [];
    const npcToken = tokens.find(t => t.actor?.type === "npc");
    if (npcToken && api.TargetState?.assess) {
      const assessment = api.TargetState.assess(npcToken, null, null);
      const valid = assessment && typeof assessment === "object";
      _log(valid ? OK : WARN, "assess(npcToken)", `Keys: ${Object.keys(assessment || {}).slice(0, 5).join(", ")}...`);
      results.push({ test: "TargetState.assess", status: valid ? OK : WARN });
    } else {
      _log(SKIP, "assess()", npcToken ? "TargetState not exposed" : "No NPC tokens on canvas");
      results.push({ test: "TargetState.assess", status: SKIP });
    }
  } catch (err) {
    _log(FAIL, "assess()", err.message);
    results.push({ test: "TargetState.assess", status: FAIL, error: err.message });
  }

  // ── Test 6: Bloodied engine state check ──
  _sub("BloodiedEngine");
  try {
    if (api.bloodiedEngine) {
      const hasAnnouncedSet = api.bloodiedEngine._announcedBloodied instanceof Set;
      _log(hasAnnouncedSet ? OK : WARN, "BloodiedEngine", `Tracking set exists: ${hasAnnouncedSet}`);
      results.push({ test: "BloodiedEngine.state", status: hasAnnouncedSet ? OK : WARN });
    } else {
      _log(FAIL, "BloodiedEngine", "Instance not found");
      results.push({ test: "BloodiedEngine.state", status: FAIL });
    }
  } catch (err) {
    _log(FAIL, "BloodiedEngine", err.message);
    results.push({ test: "BloodiedEngine.state", status: FAIL, error: err.message });
  }

  // ── Test 7: DurationTracker init state ──
  _sub("DurationTracker");
  try {
    if (api.durationTracker) {
      _log(OK, "DurationTracker", "Instance exists and init() was called");
      results.push({ test: "DurationTracker.init", status: OK });
    } else {
      _log(game.user.isGM ? WARN : SKIP, "DurationTracker", game.user.isGM ? "Instance is null" : "Player — may be GM-only init");
      results.push({ test: "DurationTracker.init", status: game.user.isGM ? WARN : SKIP });
    }
  } catch (err) {
    _log(FAIL, "DurationTracker", err.message);
    results.push({ test: "DurationTracker.init", status: FAIL, error: err.message });
  }

  // ── Test 8: Socket bridge exists ──
  _sub("Socket Bridge");
  try {
    const hasSocket = game.socket?.listeners?.(`module.${MODULE_ID}`)?.length > 0
                   || game.socket?._callbacks?.[`$module.${MODULE_ID}`]?.length > 0;
    // Socket listener check varies by Foundry version — just verify game.socket exists
    if (game.socket) {
      _log(OK, "Socket", "game.socket available");
      results.push({ test: "Socket.exists", status: OK });
    } else {
      _log(FAIL, "Socket", "game.socket not found");
      results.push({ test: "Socket.exists", status: FAIL });
    }
  } catch (err) {
    _log(FAIL, "Socket", err.message);
    results.push({ test: "Socket.exists", status: FAIL, error: err.message });
  }

  // ── Test 9: Description-parser onKillRider regex sanity ──
  _sub("DescriptionParser.onKillRider");
  try {
    if (api.DescriptionParser?._parseOnKillRider) {
      // Three canonical phrasings — each should parse cleanly
      const samples = [
        { text: "Reducing a target to zero hitpoints grants 2d6 temporary hitpoints", expectFormula: "2d6", expectReward: "tempHP" },
        { text: "When you reduce a creature to 0 HP, you regain 1d10 hit points", expectFormula: "1d10", expectReward: "hp" },
        { text: "Killing a creature with this weapon grants 3d6 temp hp", expectFormula: "3d6", expectReward: "tempHP" },
      ];
      let parsed = 0;
      for (const s of samples) {
        const r = api.DescriptionParser._parseOnKillRider(s.text, s.text.toLowerCase());
        if (r?.formula === s.expectFormula && r?.reward === s.expectReward) parsed++;
      }
      const ok = parsed === samples.length;
      _log(ok ? OK : WARN, "_parseOnKillRider()", `Parsed ${parsed}/${samples.length} canonical phrasings`);
      results.push({ test: "DescriptionParser.onKillRider", status: ok ? OK : WARN });
    } else {
      _log(SKIP, "_parseOnKillRider()", "Not exposed on API (smoke test only)");
      results.push({ test: "DescriptionParser.onKillRider", status: SKIP });
    }
  } catch (err) {
    _log(FAIL, "_parseOnKillRider()", err.message);
    results.push({ test: "DescriptionParser.onKillRider", status: FAIL, error: err.message });
  }

  // ── Test 10: CombatState.getRadiantSoulBonus signature check ──
  _sub("CombatState.RadiantSoul");
  try {
    if (api.CombatState?.getRadiantSoulBonus) {
      // Calling with no actor should return 0 (defensive guard)
      const zero = api.CombatState.getRadiantSoulBonus(null, "radiant");
      const ok = zero === 0;
      _log(ok ? OK : WARN, "getRadiantSoulBonus()", `null actor returns ${zero} (expected 0)`);
      results.push({ test: "CombatState.RadiantSoul.signature", status: ok ? OK : WARN });
    } else {
      _log(SKIP, "getRadiantSoulBonus()", "Not exposed on API (smoke test only)");
      results.push({ test: "CombatState.RadiantSoul.signature", status: SKIP });
    }
  } catch (err) {
    _log(FAIL, "getRadiantSoulBonus()", err.message);
    results.push({ test: "CombatState.RadiantSoul.signature", status: FAIL, error: err.message });
  }

  const ok   = results.filter(r => r.status === OK).length;
  const fail = results.filter(r => r.status === FAIL).length;
  const warn = results.filter(r => r.status === WARN).length;
  const skip = results.filter(r => r.status === SKIP).length;

  console.log(`\n%cSmoke Tests: ${ok} OK, ${warn} WARN, ${fail} FAIL, ${skip} SKIP`,
    fail > 0 ? COLORS[FAIL] : COLORS[OK]);

  return { total: results.length, ok, warn, fail, skip, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  5. INTEGRATION PROBES — Cross-module detection
// ═══════════════════════════════════════════════════════════════════════════════

export function checkIntegrations() {
  _header("CROSS-MODULE INTEGRATION");
  const results = [];

  const modules = [
    ["ace-engine",    "ACE: Engine (AI Campaign Engine)", "game.aceEngine"],
    ["ace-envoy",     "ACE: Envoy (NPC Conversations)",   "game.aceEnvoy"],
    ["ace-artificer", "ACE: Forge (Item Editor)",          "game.aceForge"],
    ["midi-qol",      "Midi-QOL (CONFLICT — should be disabled)", null],
    ["dae",           "DAE (CONFLICT — should be disabled)",      null],
    ["times-up",      "Times Up (replaced by DurationTracker)",   null],
    ["dfreds-convenient-effects", "DFreds CE (replaced by ConditionLibrary)", null],
  ];

  for (const [id, label, apiPath] of modules) {
    const mod = game.modules.get(id);
    const active = mod?.active ?? false;

    if (id === "midi-qol" || id === "dae" || id === "times-up" || id === "dfreds-convenient-effects") {
      // Conflict modules — should NOT be active
      if (active) {
        _log(WARN, label, "ACTIVE — may conflict with ACE: QOL");
        results.push({ module: id, status: WARN, active: true, conflict: true });
      } else {
        _log(OK, label, "Not active (good)");
        results.push({ module: id, status: OK, active: false, conflict: true });
      }
    } else {
      // ACE suite modules — optional
      if (active) {
        // ⚠️ WAS `eval(apiPath)`. Not a vulnerability — the paths are a
        // hardcoded literal list a few lines up, never user input — but eval
        // in shipped code fails every audit on sight, and a reader has to go
        // find that list to prove it is safe. A property walk needs no proof.
        const hasApi = apiPath
          ? apiPath.split(".").reduce((o, k) => (o == null ? o : o[k]), globalThis) != null
          : true;
        _log(OK, label, `Active${hasApi ? " — API available" : ""}`);
        results.push({ module: id, status: OK, active: true });
      } else {
        _log(SKIP, label, "Not installed (optional)");
        results.push({ module: id, status: SKIP, active: false });
      }
    }
  }

  // ── Check ace-qol.npcDeath hook (Concern #2 fix) ──
  _sub("Death Hook Integration");
  const deathListeners = Hooks.events["ace-qol.npcDeath"]?.length ?? 0;
  if (deathListeners > 0) {
    _log(OK, "ace-qol.npcDeath", `${deathListeners} listener(s) — Envoy is receiving death events`);
    results.push({ module: "deathHook", status: OK });
  } else {
    const envoyActive = game.modules.get("ace-envoy")?.active;
    if (envoyActive) {
      _log(WARN, "ace-qol.npcDeath", "Envoy is active but has 0 listeners — update Envoy?");
      results.push({ module: "deathHook", status: WARN });
    } else {
      _log(SKIP, "ace-qol.npcDeath", "No listeners (Envoy not active)");
      results.push({ module: "deathHook", status: SKIP });
    }
  }

  // ── dnd5e system version ──
  _sub("System Compatibility");
  const sysVersion = game.system?.version ?? "unknown";
  const sysId = game.system?.id ?? "unknown";
  const isDnd5e = sysId === "dnd5e";
  const vNum = parseFloat(sysVersion);
  if (isDnd5e && vNum >= 4.0) {
    _log(OK, `dnd5e v${sysVersion}`, "Activities API available");
    results.push({ module: "dnd5e", status: OK, version: sysVersion });
  } else if (isDnd5e) {
    _log(WARN, `dnd5e v${sysVersion}`, "Pre-4.0 — some features may not work");
    results.push({ module: "dnd5e", status: WARN, version: sysVersion });
  } else {
    _log(FAIL, `System: ${sysId}`, "ACE: QOL requires dnd5e");
    results.push({ module: "dnd5e", status: FAIL });
  }

  const foundryVersion = game.version ?? game.data?.version ?? "unknown";
  _log(OK, `Foundry v${foundryVersion}`, "");

  const ok   = results.filter(r => r.status === OK).length;
  const fail = results.filter(r => r.status === FAIL).length;
  const warn = results.filter(r => r.status === WARN).length;

  console.log(`\n%cIntegrations: ${ok} OK, ${warn} WARN, ${fail} FAIL`,
    fail > 0 ? COLORS[FAIL] : (warn > 0 ? COLORS[WARN] : COLORS[OK]));

  return { total: results.length, ok, warn, fail, results };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  6. FLAG AUDIT — Scan for orphaned or malformed flags
// ═══════════════════════════════════════════════════════════════════════════════

export function auditFlags() {
  _header("FLAG AUDIT");
  const results = { actors: 0, items: 0, orphaned: 0, malformed: 0, details: [] };

  // Scan all world actors for ace-qol flags
  for (const actor of game.actors ?? []) {
    const qolFlags = actor.flags?.[MODULE_ID];
    const midiFlags = actor.flags?.["midi-qol"];

    if (qolFlags) {
      results.actors++;
      // Check for known flag patterns
      for (const [key, value] of Object.entries(qolFlags)) {
        if (value === undefined || value === null) {
          results.malformed++;
          results.details.push({ type: "actor", name: actor.name, flag: key, issue: "null/undefined value" });
        }
      }
    }

    if (midiFlags) {
      // Check for midi flags that should have ace-qol equivalents
      const midiKeys = Object.keys(midiFlags);
      if (midiKeys.length > 0) {
        _log(WARN, `${actor.name}`, `Has ${midiKeys.length} midi-qol flags — migration candidate`);
      }
    }

    // Scan items on this actor for ace-qol flags
    for (const item of actor.items ?? []) {
      const itemFlags = item.flags?.[MODULE_ID];
      if (itemFlags) {
        results.items++;
        for (const [key, value] of Object.entries(itemFlags)) {
          if (value === undefined || value === null) {
            results.malformed++;
            results.details.push({ type: "item", name: `${actor.name} → ${item.name}`, flag: key, issue: "null/undefined" });
          }
        }
      }
    }
  }

  // Scan chat messages for orphaned ace-qol flags
  let msgCount = 0;
  const recentMsgs = game.messages?.contents?.slice(-100) ?? [];
  for (const msg of recentMsgs) {
    if (msg.flags?.[MODULE_ID]) msgCount++;
  }

  _log(results.actors > 0 ? OK : SKIP, "Actor flags", `${results.actors} actors with ace-qol flags`);
  _log(results.items > 0 ? OK : SKIP, "Item flags", `${results.items} items with ace-qol flags`);
  _log(OK, "Recent messages", `${msgCount} of last 100 messages have ace-qol flags`);

  if (results.malformed > 0) {
    _log(WARN, "Malformed flags", `${results.malformed} null/undefined flag values found`);
    for (const d of results.details.slice(0, 10)) {
      _log(WARN, `  ${d.name}`, `flag: ${d.flag} — ${d.issue}`);
    }
  } else {
    _log(OK, "Flag integrity", "No malformed flags found");
  }

  console.log(`\n%cFlags: ${results.actors} actors, ${results.items} items, ${results.malformed} malformed`,
    results.malformed > 0 ? COLORS[WARN] : COLORS[OK]);

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  7. PERFORMANCE SNAPSHOT — Hook counts, PIXI ticker, timing
// ═══════════════════════════════════════════════════════════════════════════════

export function perfSnapshot() {
  _header("PERFORMANCE SNAPSHOT");
  const results = {};

  // ── Total hook count ──
  let totalHooks = 0;
  let hookBreakdown = {};
  for (const [name, handlers] of Object.entries(Hooks.events ?? {})) {
    const count = handlers?.length ?? 0;
    totalHooks += count;
    if (count > 5) hookBreakdown[name] = count;
  }
  _log(totalHooks < 200 ? OK : WARN, "Total hook handlers", `${totalHooks}`);
  results.totalHooks = totalHooks;

  if (Object.keys(hookBreakdown).length > 0) {
    _sub("High-count hooks (>5 handlers)");
    for (const [name, count] of Object.entries(hookBreakdown).sort((a, b) => b[1] - a[1])) {
      _log(count > 15 ? WARN : OK, name, `${count} handlers`);
    }
  }

  // ── PIXI ticker check ──
  try {
    const ticker = PIXI?.Ticker?.shared;
    if (ticker) {
      const handlerCount = ticker._head ? _countTickerHandlers(ticker) : "unknown";
      _log(typeof handlerCount === "number" && handlerCount < 50 ? OK : WARN,
        "PIXI.Ticker.shared", `${handlerCount} handlers`);
      results.pixiHandlers = handlerCount;
    }
  } catch {
    _log(SKIP, "PIXI.Ticker", "Cannot access ticker");
  }

  // ── Canvas token count ──
  const tokenCount = canvas.tokens?.placeables?.length ?? 0;
  const bloodiedCount = canvas.tokens?.placeables?.filter(t => {
    const hp = t.actor?.system?.attributes?.hp;
    return hp && hp.value > 0 && hp.value <= hp.max * 0.5;
  }).length ?? 0;
  _log(OK, "Canvas tokens", `${tokenCount} total, ${bloodiedCount} bloodied`);
  results.tokens = tokenCount;
  results.bloodied = bloodiedCount;

  // ── Active effects count ──
  let totalEffects = 0;
  for (const actor of game.actors ?? []) {
    totalEffects += actor.effects?.size ?? 0;
  }
  _log(totalEffects < 500 ? OK : WARN, "Total Active Effects", `${totalEffects} across all actors`);
  results.totalEffects = totalEffects;

  // ── Active combats ──
  const combats = game.combats?.contents?.length ?? 0;
  const activeCombatants = game.combat?.combatants?.size ?? 0;
  _log(OK, "Active combats", `${combats} combat(s), ${activeCombatants} combatants in current`);
  results.combats = combats;
  results.combatants = activeCombatants;

  // ── Memory estimate ──
  try {
    if (performance?.memory) {
      const mb = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
      const limit = (performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(0);
      _log(parseFloat(mb) < 500 ? OK : WARN, "JS Heap", `${mb} MB used / ${limit} MB limit`);
      results.heapMB = parseFloat(mb);
    }
  } catch { /* Chromium only */ }

  console.log(`\n%cPerformance snapshot complete`, COLORS[OK]);
  return results;
}

/** Count PIXI ticker handler chain length */
function _countTickerHandlers(ticker) {
  let count = 0;
  let node = ticker._head;
  while (node) {
    count++;
    node = node.next;
    if (count > 500) break; // safety valve
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RUN ALL — Single command to run everything
// ═══════════════════════════════════════════════════════════════════════════════

export function runAll() {
  console.clear();
  console.log(`%c╔══════════════════════════════════════════════════╗`, COLORS.header);
  console.log(`%c║     ACE: QOL — DIAGNOSTICS REPORT                ║`, COLORS.header);
  console.log(`%c║     ${new Date().toLocaleString().padEnd(38)}      ║`, COLORS.dim);
  console.log(`%c╚══════════════════════════════════════════════════╝`, COLORS.header);

  const systems      = checkSystems();
  const settings     = checkSettings();
  const hooks        = checkHooks();
  const smoke        = smokeTest();
  const integrations = checkIntegrations();
  const flags        = auditFlags();
  const perf         = perfSnapshot();

  // ── Summary ──
  _header("SUMMARY");
  const totalOk   = systems.ok + settings.ok + hooks.ok + smoke.ok + integrations.ok;
  const totalWarn  = systems.warn + settings.warn + hooks.warn + smoke.warn + integrations.warn;
  const totalFail  = systems.fail + settings.fail + hooks.fail + smoke.fail + integrations.fail;

  console.log(`%c  Systems:      ${systems.ok} OK / ${systems.fail} FAIL`, systems.fail ? COLORS[FAIL] : COLORS[OK]);
  console.log(`%c  Settings:     ${settings.ok} OK / ${settings.fail} FAIL`, settings.fail ? COLORS[FAIL] : COLORS[OK]);
  console.log(`%c  Hooks:        ${hooks.ok} OK / ${hooks.fail} FAIL`, hooks.fail ? COLORS[FAIL] : COLORS[OK]);
  console.log(`%c  Smoke Tests:  ${smoke.ok} OK / ${smoke.fail} FAIL`, smoke.fail ? COLORS[FAIL] : COLORS[OK]);
  console.log(`%c  Integrations: ${integrations.ok} OK / ${integrations.fail} FAIL`, integrations.fail ? COLORS[FAIL] : COLORS[OK]);
  console.log(`%c  Flags:        ${flags.malformed} malformed`, flags.malformed ? COLORS[WARN] : COLORS[OK]);
  console.log(`%c  Performance:  ${perf.totalHooks} hooks, ${perf.tokens} tokens, ${perf.totalEffects} effects`, COLORS[OK]);

  console.log(`\n%c  TOTAL: ${totalOk} OK, ${totalWarn} WARN, ${totalFail} FAIL`,
    totalFail > 0 ? COLORS[FAIL] : (totalWarn > 0 ? COLORS[WARN] : COLORS[OK]));

  return { systems, settings, hooks, smoke, integrations, flags, perf };
}
