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
export type TerminalCopyOnSelect = "off" | "primary" | "clipboard";

/** A program reading the clipboard with OSC 52. */
export type TerminalClipboardRead = "ask" | "allow" | "deny";

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
};

export const NOTIFY_AFTER_SECONDS_MIN = 1;
export const NOTIFY_AFTER_SECONDS_MAX = 3600;
export const SCROLL_MULTIPLIER_MIN = 1;
export const SCROLL_MULTIPLIER_MAX = 20;

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
