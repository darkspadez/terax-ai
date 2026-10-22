/**
 * How the terminal behaves around input, the clipboard and notifications.
 * Kept as one preference object so new switches add a field here instead of
 * a key, loader, setter and change mapping each. Defaults follow Ghostty.
 */

/** macOS: which Option key types Alt (ESC-prefixed) instead of composing. */
export type TerminalOptionAsAlt = "off" | "left" | "right" | "both";

/**
 * Copy a finished selection: "primary" fills the Linux primary selection
 * (pasted with the middle button) and does nothing elsewhere; "clipboard"
 * also fills the system clipboard.
 */
type TerminalCopyOnSelect = "off" | "primary" | "clipboard";

/** A program reading the clipboard with OSC 52. */
type TerminalClipboardRead = "ask" | "allow" | "deny";

/**
 * Global hotkeys offered for the quick terminal, in Tauri's accelerator syntax
 * ("off" is none). A fixed list: each is known to parse and to be free of the
 * usual system bindings on the platforms that offer it.
 */
export const QUICK_TERMINAL_HOTKEYS = [
  "off",
  "CommandOrControl+`",
  "Control+`",
  "Alt+Space",
  "CommandOrControl+Shift+Space",
  "F12",
] as const;
export type QuickTerminalHotkey = (typeof QUICK_TERMINAL_HOTKEYS)[number];

/** Notify when a command that ran long enough finishes. */
export type TerminalNotifyOnFinish = "never" | "unfocused" | "always";

export type TerminalBehavior = {
  readonly optionAsAlt: TerminalOptionAsAlt;
  readonly copyOnSelect: TerminalCopyOnSelect;
  /** Confirm pastes that would run commands (newlines without bracketed paste). */
  readonly pasteProtection: boolean;
  readonly clipboardRead: TerminalClipboardRead;
  /** Show OSC 9 / OSC 777 notifications from programs. */
  readonly desktopNotifications: boolean;
  readonly notifyOnCommandFinish: TerminalNotifyOnFinish;
  /** Minimum command duration, in seconds, for a finish notification. */
  readonly notifyAfterSeconds: number;
  /** Play a sound for BEL (the tab is always marked). */
  readonly bellSound: boolean;
  /** Lines per mouse-wheel notch; trackpads scroll by distance. */
  readonly scrollMultiplier: number;
  /** Save each pane's recent history and show it again after a restart. */
  readonly restoreScrollback: boolean;
  /** Global hotkey that shows and hides the quick terminal, or "off". */
  readonly quickTerminalHotkey: QuickTerminalHotkey;
  /** Hide the quick terminal when another window takes focus. */
  readonly quickTerminalAutohide: boolean;
};

const NOTIFY_AFTER_SECONDS_MIN = 1;
const NOTIFY_AFTER_SECONDS_MAX = 3600;
const SCROLL_MULTIPLIER_MIN = 1;
const SCROLL_MULTIPLIER_MAX = 20;

export function defaultTerminalBehavior(
  platform: "linux" | "macos" | "windows" | "other",
): TerminalBehavior {
  return {
    optionAsAlt: "off",
    copyOnSelect: platform === "linux" ? "primary" : "off",
    pasteProtection: true,
    clipboardRead: "ask",
    desktopNotifications: true,
    notifyOnCommandFinish: "unfocused",
    notifyAfterSeconds: 10,
    bellSound: false,
    scrollMultiplier: 3,
    restoreScrollback: true,
    quickTerminalHotkey: "off",
    quickTerminalAutohide: true,
  };
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** Stored (possibly partial, older or hand-edited) value to a complete one. */
export function normalizeTerminalBehavior(
  value: unknown,
  defaults: TerminalBehavior,
): TerminalBehavior {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    optionAsAlt: oneOf(
      raw.optionAsAlt,
      ["off", "left", "right", "both"],
      defaults.optionAsAlt,
    ),
    copyOnSelect: oneOf(
      raw.copyOnSelect,
      ["off", "primary", "clipboard"],
      defaults.copyOnSelect,
    ),
    pasteProtection:
      typeof raw.pasteProtection === "boolean"
        ? raw.pasteProtection
        : defaults.pasteProtection,
    clipboardRead: oneOf(
      raw.clipboardRead,
      ["ask", "allow", "deny"],
      defaults.clipboardRead,
    ),
    desktopNotifications:
      typeof raw.desktopNotifications === "boolean"
        ? raw.desktopNotifications
        : defaults.desktopNotifications,
    notifyOnCommandFinish: oneOf(
      raw.notifyOnCommandFinish,
      ["never", "unfocused", "always"],
      defaults.notifyOnCommandFinish,
    ),
    notifyAfterSeconds: boundedInteger(
      raw.notifyAfterSeconds,
      NOTIFY_AFTER_SECONDS_MIN,
      NOTIFY_AFTER_SECONDS_MAX,
      defaults.notifyAfterSeconds,
    ),
    bellSound:
      typeof raw.bellSound === "boolean" ? raw.bellSound : defaults.bellSound,
    scrollMultiplier: boundedInteger(
      raw.scrollMultiplier,
      SCROLL_MULTIPLIER_MIN,
      SCROLL_MULTIPLIER_MAX,
      defaults.scrollMultiplier,
    ),
    restoreScrollback:
      typeof raw.restoreScrollback === "boolean"
        ? raw.restoreScrollback
        : defaults.restoreScrollback,
    quickTerminalHotkey: oneOf(
      raw.quickTerminalHotkey,
      QUICK_TERMINAL_HOTKEYS,
      defaults.quickTerminalHotkey,
    ),
    quickTerminalAutohide:
      typeof raw.quickTerminalAutohide === "boolean"
        ? raw.quickTerminalAutohide
        : defaults.quickTerminalAutohide,
  };
}

export function currentPlatform(): "linux" | "macos" | "windows" | "other" {
  if (typeof navigator === "undefined") return "other";
  const agent = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(agent)) return "macos";
  if (/Windows/.test(agent)) return "windows";
  if (/Linux|X11/.test(agent)) return "linux";
  return "other";
}
