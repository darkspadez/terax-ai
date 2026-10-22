import { IS_MAC, IS_WINDOWS } from "@/lib/platform";

/**
 * Single source of truth for keyboard shortcuts.
 */

export type ShortcutId =
  | "commandPalette.open"
  | "commandPalette.content"
  | "window.new"
  | "tab.new"
  | "tab.newBlock"
  | "tab.newPrivate"
  | "tab.newPreview"
  | "tab.newEditor"
  | "tab.close"
  | "tab.next"
  | "tab.prev"
  | "tab.selectByIndex"
  | "space.next"
  | "space.prev"
  | "space.overview"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.focusNext"
  | "pane.focusPrev"
  | "pane.swapLeft"
  | "pane.swapRight"
  | "pane.swapUp"
  | "pane.swapDown"
  | "pane.focusLeft"
  | "pane.focusRight"
  | "pane.focusUp"
  | "pane.focusDown"
  | "pane.zoom"
  | "pane.resizeLeft"
  | "pane.resizeRight"
  | "pane.resizeUp"
  | "pane.resizeDown"
  | "pane.equalize"
  | "pane.source"
  | "terminal.clear"
  | "terminal.restart"
  | "terminal.toggleInput"
  | "blocks.prev"
  | "blocks.next"
  | "terminal.scrollPageUp"
  | "terminal.scrollPageDown"
  | "terminal.scrollTop"
  | "terminal.scrollBottom"
  | "terminal.fontSizeUp"
  | "terminal.fontSizeDown"
  | "terminal.fontSizeReset"
  | "search.focus"
  | "explorer.search"
  | "explorer.focus"
  | "explorer.toggleHidden"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.zoomReset"
  | "view.zenMode"
  | "ai.toggle"
  | "ai.toggleMini"
  | "ai.askSelection"
  | "agent.focusAttention"
  | "settings.open"
  | "sidebar.toggle"
  | "editor.undo"
  | "editor.redo"
  | "editor.save"
  | "editor.aiComplete"
  | "editor.codeComplete";

export type ShortcutGroup =
  | "General"
  | "Tabs"
  | "Spaces"
  | "Panes"
  | "Terminal"
  | "Search"
  | "AI"
  | "View"
  | "Editor";

export type KeyBinding = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
};

export type Shortcut = {
  id: ShortcutId;
  label: string;
  group: ShortcutGroup;
  defaultBindings: KeyBinding[];
  allowRepeat?: boolean;
};

export type ShortcutPlatform = "macos" | "windows" | "linux";

/**
 * The default shortcuts on a platform. macOS uses Cmd. Windows and Linux use
 * Ctrl+Shift for every app shortcut that macOS puts on Cmd+key, as Ghostty
 * and Windows Terminal do, so it works in a focused terminal; plain Ctrl+key
 * stays as a second binding, which a focused terminal keeps for its programs
 * (`shouldDeferShortcutToTerminal`). The Cmd+Shift shortcuts whose Ctrl+Shift
 * chord went to such a shortcut move to Ctrl+Alt+Shift there.
 */
export function defaultShortcuts(platform: ShortcutPlatform): Shortcut[] {
  const mac = platform === "macos";
  const mod: "meta" | "ctrl" = mac ? "meta" : "ctrl";
  /** Cmd+key on macOS; Ctrl+Shift+key, then Ctrl+key, elsewhere. */
  const command = (key: string): KeyBinding[] =>
    mac
      ? [{ meta: true, key }]
      : [
          { ctrl: true, shift: true, key },
          { ctrl: true, key },
        ];
  /** Cmd+Shift+key on macOS; Ctrl+Alt+Shift+key elsewhere. */
  const shiftedCommand = (key: string): KeyBinding[] =>
    mac
      ? [{ meta: true, shift: true, key }]
      : [{ ctrl: true, alt: true, shift: true, key }];

  return [
    {
      id: "commandPalette.open",
      label: "Open command palette",
      group: "General",
      defaultBindings: command("p"),
    },
    {
      id: "commandPalette.content",
      label: "Find in files",
      group: "General",
      defaultBindings: shiftedCommand("p"),
    },
    {
      id: "settings.open",
      label: "Open settings",
      group: "General",
      defaultBindings: [{ [mod]: true, key: "," }],
    },
    {
      id: "window.new",
      label: "New window",
      group: "General",
      defaultBindings: [{ [mod]: true, shift: true, key: "n" }],
    },
    {
      id: "tab.new",
      label: "New tab",
      group: "Tabs",
      defaultBindings: command("t"),
    },
    {
      id: "tab.newBlock",
      label: "New Blocks terminal",
      group: "Tabs",
      defaultBindings: shiftedCommand("t"),
    },
    {
      id: "tab.newPrivate",
      label: "New private terminal",
      group: "Tabs",
      defaultBindings: command("r"),
    },
    {
      id: "tab.newPreview",
      label: "New web preview",
      group: "Tabs",
      // Cmd/Ctrl+P now opens the command palette, so web preview moves here.
      defaultBindings: [{ [mod]: true, shift: true, key: "o" }],
    },
    {
      id: "tab.newEditor",
      label: "New editor tab",
      group: "Tabs",
      defaultBindings: command("e"),
    },
    {
      id: "tab.close",
      label: "Close tab or pane",
      group: "Tabs",
      defaultBindings: command("w"),
    },
    {
      id: "pane.splitRight",
      label: "Split pane right",
      group: "Panes",
      defaultBindings: command("d"),
    },
    {
      id: "pane.splitDown",
      label: "Split pane down",
      group: "Panes",
      defaultBindings: shiftedCommand("d"),
    },
    {
      id: "pane.focusNext",
      label: "Focus next pane",
      group: "Panes",
      defaultBindings: command("]"),
    },
    {
      id: "pane.focusPrev",
      label: "Focus previous pane",
      group: "Panes",
      defaultBindings: command("["),
    },
    {
      id: "pane.swapLeft",
      label: "Swap pane left",
      group: "Panes",
      defaultBindings: [{ [mod]: true, alt: true, key: "ArrowLeft" }],
    },
    {
      id: "pane.swapRight",
      label: "Swap pane right",
      group: "Panes",
      defaultBindings: [{ [mod]: true, alt: true, key: "ArrowRight" }],
    },
    {
      id: "pane.swapUp",
      label: "Swap pane up",
      group: "Panes",
      defaultBindings: [{ [mod]: true, alt: true, key: "ArrowUp" }],
    },
    {
      id: "pane.swapDown",
      label: "Swap pane down",
      group: "Panes",
      defaultBindings: [{ [mod]: true, alt: true, key: "ArrowDown" }],
    },
    ...(["Left", "Right", "Up", "Down"] as const).map(
      (side): Shortcut => ({
        id: `pane.focus${side}`,
        label: `Focus pane ${side.toLowerCase()}`,
        group: "Panes",
        defaultBindings: [{ [mod]: true, shift: true, key: `Arrow${side}` }],
      }),
    ),
    {
      id: "pane.zoom",
      label: "Zoom pane (show it alone)",
      group: "Panes",
      defaultBindings: [{ [mod]: true, shift: true, key: "Enter" }],
    },
    // Ghostty's resize_split keys: ⌘⌃Arrow on macOS, Ctrl+Alt+Shift+Arrow
    // elsewhere (Ctrl+Alt+Arrow is pane swapping here).
    ...(["Left", "Right", "Up", "Down"] as const).map(
      (side): Shortcut => ({
        id: `pane.resize${side}`,
        label: `Move pane divider ${side.toLowerCase()}`,
        group: "Panes",
        defaultBindings: mac
          ? [{ meta: true, ctrl: true, key: `Arrow${side}` }]
          : [{ ctrl: true, alt: true, shift: true, key: `Arrow${side}` }],
        allowRepeat: true,
      }),
    ),
    {
      id: "pane.equalize",
      label: "Equalize pane sizes",
      group: "Panes",
      defaultBindings: mac
        ? [{ meta: true, ctrl: true, key: "=" }]
        : [{ ctrl: true, alt: true, shift: true, key: "+" }],
    },
    {
      id: "pane.source",
      label: "Toggle source panel",
      group: "Panes",
      defaultBindings: command("g"),
    },
    {
      id: "terminal.clear",
      label: "Clear terminal",
      group: "Terminal",
      // macOS Terminal's ⌘K (clear scrollback, keep the prompt). Default only on
      // macOS — on other platforms Ctrl+K is readline's kill-line, so we leave it
      // unbound and let users assign their own in settings.
      defaultBindings: mac ? [{ meta: true, key: "k" }] : [],
    },
    // Unbound by default, since it ends what runs in the pane; in the palette.
    {
      id: "terminal.restart",
      label: "Restart terminal",
      group: "Terminal",
      defaultBindings: [],
    },
    {
      id: "terminal.toggleInput",
      label: "Toggle Shell / AI input",
      group: "Terminal",
      // Linux input methods (IBus, Fcitx) take Ctrl+Shift+U for Unicode entry.
      defaultBindings:
        platform === "linux"
          ? [
              { ctrl: true, alt: true, shift: true, key: "u" },
              { ctrl: true, key: "u" },
            ]
          : command("u"),
    },
    {
      id: "blocks.prev",
      label: "Previous prompt",
      group: "Terminal",
      defaultBindings: [{ [mod]: true, key: "ArrowUp" }],
      allowRepeat: true,
    },
    {
      id: "blocks.next",
      label: "Next prompt",
      group: "Terminal",
      defaultBindings: [{ [mod]: true, key: "ArrowDown" }],
      allowRepeat: true,
    },
    {
      id: "terminal.scrollPageUp",
      label: "Scroll up one page",
      group: "Terminal",
      defaultBindings: [{ shift: true, key: "PageUp" }],
      allowRepeat: true,
    },
    {
      id: "terminal.scrollPageDown",
      label: "Scroll down one page",
      group: "Terminal",
      defaultBindings: [{ shift: true, key: "PageDown" }],
      allowRepeat: true,
    },
    {
      id: "terminal.scrollTop",
      label: "Scroll to the top",
      group: "Terminal",
      defaultBindings: mac
        ? [{ meta: true, key: "Home" }]
        : [{ shift: true, key: "Home" }],
    },
    {
      id: "terminal.scrollBottom",
      label: "Scroll to the bottom",
      group: "Terminal",
      defaultBindings: mac
        ? [{ meta: true, key: "End" }]
        : [{ shift: true, key: "End" }],
    },
    // Per-pane text size. Unbound by default: ⌘/Ctrl +/- zoom the whole app.
    {
      id: "terminal.fontSizeUp",
      label: "Increase pane font size",
      group: "Terminal",
      defaultBindings: [],
      allowRepeat: true,
    },
    {
      id: "terminal.fontSizeDown",
      label: "Decrease pane font size",
      group: "Terminal",
      defaultBindings: [],
      allowRepeat: true,
    },
    {
      id: "terminal.fontSizeReset",
      label: "Reset pane font size",
      group: "Terminal",
      defaultBindings: [],
    },
    {
      id: "tab.next",
      label: "Next tab",
      group: "Tabs",
      defaultBindings: [{ ctrl: true, key: "Tab" }],
      allowRepeat: true,
    },
    {
      id: "tab.prev",
      label: "Previous tab",
      group: "Tabs",
      defaultBindings: [{ ctrl: true, shift: true, key: "Tab" }],
      allowRepeat: true,
    },
    {
      id: "tab.selectByIndex",
      label: "Jump to tab 1–9",
      group: "Tabs",
      defaultBindings: [{ [mod]: true, key: "1" }],
    },
    {
      id: "space.next",
      label: "Next space",
      group: "Spaces",
      defaultBindings: shiftedCommand("]"),
    },
    {
      id: "space.prev",
      label: "Previous space",
      group: "Spaces",
      defaultBindings: shiftedCommand("["),
    },
    {
      id: "space.overview",
      label: "Open spaces",
      group: "Spaces",
      defaultBindings: [{ [mod]: true, shift: true, key: "s" }],
    },
    {
      id: "explorer.search",
      label: "Search files",
      group: "Search",
      defaultBindings: shiftedCommand("f"),
    },
    {
      id: "search.focus",
      label: "Find in tab",
      group: "Search",
      defaultBindings: command("f"),
    },
    {
      id: "ai.toggle",
      label: "Toggle AI agent",
      group: "AI",
      defaultBindings: command("i"),
    },
    {
      id: "ai.toggleMini",
      label: "Toggle AI chat window",
      group: "AI",
      defaultBindings: shiftedCommand("i"),
    },
    {
      id: "ai.askSelection",
      label: "Ask AI about selection",
      group: "AI",
      // Keep Mod+L available to the shell for clear-screen, including when
      // terminal text is selected and this shortcut is otherwise eligible.
      defaultBindings: command("j"),
    },
    {
      id: "agent.focusAttention",
      label: "Jump to agent needing attention",
      group: "AI",
      defaultBindings: [{ [mod]: true, shift: true, key: "a" }],
    },
    {
      id: "sidebar.toggle",
      label: "Toggle file explorer",
      group: "View",
      // Plain Mod+B toggles the sidebar everywhere EXCEPT a focused terminal,
      // where it's handed to the shell / Claude Code (its "run in background"
      // key). Mod+Shift+B always toggles, including from inside a terminal.
      defaultBindings: mac
        ? [
            { meta: true, key: "b" },
            { meta: true, shift: true, key: "b" },
          ]
        : command("b"),
    },
    {
      id: "explorer.focus",
      label: "Toggle file explorer focus",
      group: "View",
      defaultBindings: shiftedCommand("e"),
    },
    {
      id: "explorer.toggleHidden",
      label: "Toggle hidden files",
      group: "View",
      // Finder's toggle. The binding is on the physical Period key, so it holds
      // on layouts where Shift+. types something else.
      defaultBindings: [{ [mod]: true, shift: true, key: "." }],
    },
    {
      id: "view.zoomIn",
      label: "Zoom in",
      group: "View",
      defaultBindings: [
        { [mod]: true, key: "=" },
        { [mod]: true, shift: true, key: "+" },
      ],
      allowRepeat: true,
    },
    {
      id: "view.zoomOut",
      label: "Zoom out",
      group: "View",
      defaultBindings: [
        { [mod]: true, key: "-" },
        { [mod]: true, shift: true, key: "_" },
      ],
      allowRepeat: true,
    },
    {
      id: "view.zoomReset",
      label: "Reset zoom",
      group: "View",
      defaultBindings: [{ [mod]: true, key: "0" }],
    },
    {
      id: "view.zenMode",
      label: "Toggle zen mode",
      group: "View",
      defaultBindings: [{ [mod]: true, shift: true, key: "'" }],
    },
    // Editor undo/redo: App.tsx registers handlers and useGlobalShortcuts
    // preventDefaults on match. Keep Mod+Y and add macOS Mod+Shift+Z (#941).
    // Still excluded from the customization UI in ShortcutsSection.
    {
      id: "editor.undo",
      label: "Undo",
      group: "Editor",
      defaultBindings: [{ [mod]: true, key: "z" }],
    },
    {
      id: "editor.redo",
      label: "Redo",
      group: "Editor",
      defaultBindings: [
        { [mod]: true, key: "y" },
        { [mod]: true, shift: true, key: "z" },
      ],
    },
    // Mod+S at the app layer so WKWebView cannot steal "Save Page" (#969).
    // CodeMirror also binds Mod-s; the global handler preventDefaults first.
    {
      id: "editor.save",
      label: "Save file",
      group: "Editor",
      defaultBindings: [{ [mod]: true, key: "s" }],
    },
    {
      id: "editor.aiComplete",
      label: "Trigger AI completion",
      group: "Editor",
      defaultBindings: [{ alt: true, key: "\\" }],
    },
    {
      id: "editor.codeComplete",
      label: "Trigger code completion",
      group: "Editor",
      defaultBindings: [{ ctrl: true, key: " " }],
    },
  ];
}

export const SHORTCUTS: Shortcut[] = defaultShortcuts(
  IS_MAC ? "macos" : IS_WINDOWS ? "windows" : "linux",
);

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  "General",
  "Tabs",
  "Panes",
  "Terminal",
  "View",
  "Search",
  "AI",
  "Editor",
];

/**
 * Matching logic: checks if a KeyboardEvent matches a KeyBinding.
 */
const CODE_TO_KEY: Record<string, string> = {
  Backslash: "\\",
  Slash: "/",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  Space: " ",
  Tab: "tab",
};

// Option and Shift combinations rewrite e.key (macOS Option gives "«", "…",
// dead keys; Shift turns "." into ">"); the physical key survives in e.code.
function keyFromCode(code: string): string | null {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return CODE_TO_KEY[code] ?? null;
}

export function matchBinding(
  e: KeyboardEvent,
  binding: KeyBinding,
  id?: ShortcutId
): boolean {
  // Windows reports AltGr as Ctrl+Alt: AltGr+Shift+E types "Ę" in Polish and
  // "É" in US International, and must not run a Ctrl+Alt+Shift+E shortcut.
  if (
    binding.ctrl &&
    binding.alt &&
    typeof e.getModifierState === "function" &&
    e.getModifierState("AltGraph")
  )
    return false;
  // X11 names Shift+Tab ISO_Left_Tab, which WebKitGTK can pass through.
  const backTab = e.key === "ISO_Left_Tab";
  const eventKey = backTab ? "tab" : e.key.toLowerCase();
  const bindingKey = binding.key.toLowerCase();

  // Special case for Jump to Tab 1-9
  if (id === "tab.selectByIndex") {
    if (!/^[1-9]$/.test(e.key)) return false;
  } else if (eventKey !== bindingKey) {
    if (!binding.alt && !binding.shift) return false;
    if (keyFromCode(e.code) !== bindingKey) return false;
  }

  return (
    !!e.ctrlKey === !!binding.ctrl &&
    (!!e.shiftKey || backTab) === !!binding.shift &&
    !!e.altKey === !!binding.alt &&
    !!e.metaKey === !!binding.meta
  );
}

/**
 * The shortcut a key event triggers with the user's bindings (defaults where
 * none are set), or null. A user's own binding wins over a default on the
 * same chord, so changed defaults never shadow a customization. Keys an input
 * method is composing with belong to it.
 */
export function matchShortcut(
  e: KeyboardEvent,
  userBindings: Partial<Record<ShortcutId, KeyBinding[]>>,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): ShortcutId | null {
  if (e.isComposing) return null;
  let byDefault: ShortcutId | null = null;
  for (const s of shortcuts) {
    if (e.repeat && !s.allowRepeat) continue;
    const custom = userBindings[s.id];
    const bindings = custom || s.defaultBindings;
    if (!bindings.some((b) => matchBinding(e, b, s.id))) continue;
    if (custom) return s.id;
    byDefault ??= s.id;
  }
  return byDefault;
}

/**
 * Display helpers
 */
export function getBindingTokens(binding?: KeyBinding): string[] {
  if (!binding) return [];
  const tokens: string[] = [];
  if (IS_MAC) {
    if (binding.ctrl) tokens.push("⌃");
    if (binding.alt) tokens.push("⌥");
    if (binding.shift) tokens.push("⇧");
    if (binding.meta) tokens.push("⌘");
  } else {
    if (binding.ctrl) tokens.push("Ctrl");
    if (binding.alt) tokens.push("Alt");
    if (binding.shift) tokens.push("Shift");
    if (binding.meta) tokens.push("Win");
  }

  let keyLabel = binding.key;
  if (keyLabel === " ") keyLabel = "Space";
  else if (keyLabel === "ArrowUp") keyLabel = "↑";
  else if (keyLabel === "ArrowDown") keyLabel = "↓";
  else if (keyLabel === "ArrowLeft") keyLabel = "←";
  else if (keyLabel === "ArrowRight") keyLabel = "→";
  else if (keyLabel.length === 1) keyLabel = keyLabel.toUpperCase();

  tokens.push(keyLabel);
  return tokens;
}
