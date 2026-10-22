import {
  type KeyBinding,
  matchBinding,
  matchShortcut,
  SHORTCUTS,
  type Shortcut,
  type ShortcutId,
} from "../shortcuts";

/**
 * The shortcuts the macOS menu bar carries as well, so they work while a
 * preview frame has the keyboard and the page never sees their keys.
 */
export type MenuShortcutId =
  | "tab.new"
  | "tab.selectByIndex"
  | "tab.next"
  | "tab.prev"
  | "commandPalette.open"
  | "ai.toggle";

/** A shortcut chosen in the menu bar (`terax:menu-shortcut`). */
export type MenuShortcut =
  | { id: Exclude<MenuShortcutId, "tab.selectByIndex"> }
  | { id: "tab.selectByIndex"; tab: number };

/**
 * The menu items' key equivalents in the menu's accelerator syntax
 * (`Cmd+Shift+KeyT`); null leaves an item without one. `app_menu.rs` reads
 * this shape.
 */
type MenuAccelerators = {
  newTab: string | null;
  /** Tab 1 to Tab 9. */
  selectTab: (string | null)[];
  nextTab: string | null;
  previousTab: string | null;
  commandPalette: string | null;
  toggleAi: string | null;
};

export type MenuShortcutPlan = {
  accelerators: MenuAccelerators;
  /** The chords the menu carries, which the page marks handled when it sees them. */
  chords: KeyBinding[];
};

export const MENU_SHORTCUT_EVENT = "terax:menu-shortcut";

const NAMED_KEYS: Readonly<Record<string, string>> = {
  "`": "Backquote",
  "\\": "Backslash",
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  "=": "Equal",
  "-": "Minus",
  ".": "Period",
  "'": "Quote",
  ";": "Semicolon",
  "/": "Slash",
  " ": "Space",
  tab: "Tab",
  enter: "Enter",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

function acceleratorKey(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^f([1-9]|1[0-9]|20)$/i.test(key)) return key.toUpperCase();
  return NAMED_KEYS[key.length === 1 ? key : key.toLowerCase()] ?? null;
}

/**
 * A binding as a menu key equivalent, or null when it cannot be one: a key the
 * menu has no physical name for (what Option or Shift typed, such as "†" or
 * "{", since bindings keep the typed character), or no modifier that keeps it
 * from typing (the shortcut recorder's rule: Cmd, Ctrl or Option, or Shift
 * with a key that types nothing).
 */
export function menuAccelerator(binding: KeyBinding): string | null {
  const key = acceleratorKey(binding.key);
  if (key === null) return null;
  const typesNothing = binding.key.length > 1;
  if (!binding.meta && !binding.ctrl && !binding.alt) {
    if (!binding.shift || !typesNothing) return null;
  }
  return [
    binding.meta && "Cmd",
    binding.ctrl && "Ctrl",
    binding.alt && "Alt",
    binding.shift && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

/** The keydown a binding's chord produces, as `matchShortcut` reads it. */
function chordEvent(binding: KeyBinding): KeyboardEvent {
  return {
    key: binding.key,
    code: "",
    repeat: false,
    isComposing: false,
    ctrlKey: !!binding.ctrl,
    shiftKey: !!binding.shift,
    altKey: !!binding.alt,
    metaKey: !!binding.meta,
  } as KeyboardEvent;
}

const TAB_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * The menu's key equivalents from the user's effective bindings: for each
 * item, the first binding of its shortcut that the shortcut itself owns (no
 * binding of the user's gives the chord to another) and that the menu can
 * carry. Jump to tab 1-9 is one item per digit on its binding's modifiers.
 */
export function menuShortcutPlan(
  userBindings: Partial<Record<ShortcutId, KeyBinding[]>>,
  shortcuts: readonly Shortcut[] = SHORTCUTS,
): MenuShortcutPlan {
  const chords: KeyBinding[] = [];
  const bindingsOf = (id: ShortcutId) =>
    userBindings[id] ??
    shortcuts.find((shortcut) => shortcut.id === id)?.defaultBindings ??
    [];
  const carry = (id: MenuShortcutId, bindings: readonly KeyBinding[]) => {
    for (const binding of bindings) {
      const accelerator = menuAccelerator(binding);
      if (accelerator === null) continue;
      if (matchShortcut(chordEvent(binding), userBindings, shortcuts) !== id)
        continue;
      chords.push(binding);
      return accelerator;
    }
    return null;
  };
  const selectBindings = bindingsOf("tab.selectByIndex");
  return {
    accelerators: {
      newTab: carry("tab.new", bindingsOf("tab.new")),
      selectTab: TAB_DIGITS.map((key) =>
        carry(
          "tab.selectByIndex",
          selectBindings.map((binding) => ({ ...binding, key })),
        ),
      ),
      nextTab: carry("tab.next", bindingsOf("tab.next")),
      previousTab: carry("tab.prev", bindingsOf("tab.prev")),
      commandPalette: carry(
        "commandPalette.open",
        bindingsOf("commandPalette.open"),
      ),
      toggleAi: carry("ai.toggle", bindingsOf("ai.toggle")),
    },
    chords,
  };
}

/**
 * Whether a key the page sees is one a menu item carries. The page marks it
 * handled, run or not (a held key's repeats, a chord a text box claims), so
 * WebKit does not pass it on to the menu: the menu runs only keys the page
 * never saw. Keys an input method composes with stay its own.
 */
export function menuCarriesKey(
  e: KeyboardEvent,
  chords: readonly KeyBinding[],
): boolean {
  return !e.isComposing && chords.some((binding) => matchBinding(e, binding));
}

const PLAIN_MENU_SHORTCUTS: ReadonlySet<string> = new Set([
  "tab.new",
  "tab.next",
  "tab.prev",
  "commandPalette.open",
  "ai.toggle",
]);

/** The shortcut a `terax:menu-shortcut` event names, or null. */
export function parseMenuShortcut(payload: unknown): MenuShortcut | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { id, tab } = payload as { id?: unknown; tab?: unknown };
  if (id === "tab.selectByIndex") {
    return typeof tab === "number" &&
      Number.isInteger(tab) &&
      tab >= 1 &&
      tab <= 9
      ? { id, tab }
      : null;
  }
  return typeof id === "string" && PLAIN_MENU_SHORTCUTS.has(id)
    ? ({ id } as MenuShortcut)
    : null;
}
