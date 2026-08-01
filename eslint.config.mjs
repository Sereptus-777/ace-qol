// Minimal ESLint config — ONE job: catch identifiers that don't exist.
//
// `node --check` validates SYNTAX only. A reference to an undeclared variable is
// perfectly valid syntax and throws only when that line actually runs. That is
// how `_targetProfileFor(targetActor, tgt)` shipped into _rollPcSave — a
// function with no `tgt` — and silently killed every player save, and how a
// second call read `r` inside its own temporal dead zone. Nothing in the build
// could have caught either. This can.
//
//   npx --yes eslint@9 "scripts/**/*.mjs"

const FOUNDRY_GLOBALS = [
  // Foundry core
  "game", "canvas", "ui", "CONFIG", "CONST", "Hooks", "foundry",
  "Roll", "ChatMessage", "Actor", "Item", "ActiveEffect", "Macro", "Folder",
  "Token", "TokenDocument", "Scene", "Combat", "Combatant", "CombatTracker",
  "User", "Users", "Dialog", "Application", "FormApplication", "DocumentSheetConfig",
  "FilePicker", "ImageHelper", "AudioHelper", "Color", "SceneNavigation",
  "renderTemplate", "loadTemplates", "TextEditor", "Handlebars",
  "fromUuid", "fromUuidSync", "duplicate", "mergeObject", "getProperty",
  "setProperty", "randomID", "jQuery", "$", "Actors", "Items", "ChatLog",
  "SettingsConfig", "KeybindingsConfig", "Tour", "ProseMirror", "Ray",
  // Third-party modules ACE talks to
  "Sequence", "Sequencer", "PIXI", "TokenMagic", "warpgate",
  // Browser / platform
  "console", "window", "document", "fetch", "URL", "URLSearchParams", "Blob",
  "FileReader", "File", "FormData", "Headers", "Request", "Response", "WebSocket",
  "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask",
  "structuredClone", "AbortController", "TextDecoder", "TextEncoder",
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent",
  "HTMLElement", "HTMLImageElement", "HTMLCanvasElement", "Node", "NodeList",
  "HTMLInputElement", "HTMLVideoElement", "HTMLSelectElement", "HTMLTextAreaElement",
  "customElements", "DOMParser", "XMLSerializer",
  "Image", "Audio", "performance", "navigator", "location", "alert", "confirm",
  "atob", "btoa", "crypto", "getComputedStyle", "MutationObserver", "ResizeObserver",
];

const globals = Object.fromEntries(FOUNDRY_GLOBALS.map(g => [g, "readonly"]));

export default [
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals },
    rules: {
      // THE rule. Any error here is a guaranteed runtime ReferenceError.
      // Keep this at zero.
      "no-undef": "error",
      // WARN, not error: this also flags the perfectly legal pattern of a
      // callback referencing a const declared further down the same scope
      // (drag handlers, Hooks.off cleanup) — those run after initialisation and
      // are fine. It's kept on because it DOES catch the dangerous version: a
      // const read in its own temporal dead zone, which is what silently broke
      // the PC card update. Nine known-safe hits as of 0.7.372; if the count
      // moves, read the new one.
      "no-use-before-define": ["warn", { functions: false, classes: false, variables: true }],
    },
  },
];
