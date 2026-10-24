import { osNotify } from "@/modules/agents/lib/notify";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type {
  TerminalBehavior,
  TerminalNotifyOnFinish,
} from "@/modules/settings/terminalBehavior";
import type { GhosttyPointerShape } from "@oarlock/ghostty-core/protocol";
import type {
  OarlockGhosttyKittyClipboardAnswer,
  OarlockGhosttyMimeData,
} from "@oarlock/ghostty-core/adapted";
import {
  readClipboardImage,
  readPrimarySelection,
  readTerminalClipboard,
} from "../lib/terminalClipboard";
import { requestTerminalPrompt } from "../lib/terminalPrompts";
import {
  type TerminalProgress,
  useTerminalStatusStore,
} from "../lib/terminalStatus";
import type {
  GhosttySemanticEventCallbacks,
  KittyClipboardReadRequest,
} from "./core/GhosttySemanticEventRouter";
import type { Rgb } from "./core/packedCells";
import type { GhosttyClipboardPolicy } from "./GhosttyTerminalModel";

/** OSC 52 clipboard reads are answered with at most this much text. */
const MAX_CLIPBOARD_REPLY_BYTES = 8 * 1024 * 1024;
/**
 * Kitty clipboard reads serve at most this much, all representations
 * together: its base64 framing stays within the 48 MiB the core lets one
 * answer queue (`max_kitty_answer_output`).
 */
const MAX_KITTY_CLIPBOARD_BYTES = 32 * 1024 * 1024;
/** The image type clipboard images are served as. */
const IMAGE_MIME = "image/png";
/** MIME types that name plain text, as Ghostty's `isTextMime` lists them. */
const TEXT_MIMES = new Set([
  "text/plain",
  "text/plain;charset=utf-8",
  "UTF8_STRING",
  "TEXT",
  "STRING",
]);

const encoder = new TextEncoder();

/** The OSC 52 reply carrying `text` (empty answers "nothing to read"). */
export function clipboardReadReply(
  selection: string,
  text: string,
  terminator: "st" | "bel",
): string {
  let bytes = encoder.encode(text);
  if (bytes.byteLength > MAX_CLIPBOARD_REPLY_BYTES) bytes = new Uint8Array(0);
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `\x1b]52;${selection};${btoa(binary)}${terminator === "bel" ? "\x07" : "\x1b\\"}`;
}

/**
 * The answer to a Kitty clipboard read once the user allowed it: the text
 * under each requested text MIME type and the image (PNG) under
 * `image/png` (Ghostty serves four at most), the types on offer when
 * listed. Null text means there is no such clipboard.
 */
export function kittyClipboardAnswer(
  mimes: readonly string[],
  text: string | null,
  image: Uint8Array | null = null,
): OarlockGhosttyKittyClipboardAnswer {
  if (text === null) return { status: "unsupported" };
  const data = encoder.encode(text);
  const png = image && image.byteLength > 0 ? image : null;
  const available: string[] = [];
  if (data.byteLength > 0) available.push("text/plain");
  if (png) available.push(IMAGE_MIME);
  const contents: OarlockGhosttyMimeData[] = [];
  let size = 0;
  for (const mime of mimes) {
    if (contents.length === 4) break;
    const served =
      TEXT_MIMES.has(mime) && data.byteLength > 0
        ? data
        : mime === IMAGE_MIME
          ? png
          : null;
    if (!served) continue;
    contents.push({ mime, data: served });
    size += served.byteLength;
  }
  if (size > MAX_KITTY_CLIPBOARD_BYTES) return { status: "io-error" };
  return { status: "success", available, contents };
}

/** Whether a finished command deserves a notification. */
export function shouldNotifyCommandFinished(
  mode: TerminalNotifyOnFinish,
  afterSeconds: number,
  durationMs: number,
  userIsLooking: boolean,
): boolean {
  if (mode === "never" || durationMs < afterSeconds * 1000) return false;
  return mode === "always" || !userIsLooking;
}

/** Text for a command-finished notification. */
export function commandFinishedMessage(
  command: string | null,
  exitCode: number | null,
  durationMs: number,
): { title: string; body: string } {
  const seconds = Math.round(durationMs / 1000);
  const took =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
  const failed = exitCode !== null && exitCode !== 0;
  return {
    title: failed ? "Command failed" : "Command finished",
    body: `${command ? `${command}\n` : ""}${failed ? `Exit code ${exitCode} · ` : ""}took ${took}`,
  };
}

/** Light or dark for DSR 996 / mode 2031, from the terminal background. */
export function colorSchemeFor(background: Rgb): "dark" | "light" {
  const [red, green, blue] = background;
  // Relative luminance (sRGB) of the background, as WCAG defines it.
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
  return luminance > 0.179 ? "light" : "dark";
}

let versionPromise: Promise<string> | null = null;

/** The XTVERSION reply: "oarlock <app version>" (just "oarlock" outside the app). */
export function terminalVersion(): Promise<string> {
  versionPromise ??= import("@tauri-apps/api/app")
    .then(({ getVersion }) => getVersion())
    .then((version) => `oarlock ${version}`)
    .catch(() => "oarlock");
  return versionPromise;
}

/**
 * CSS cursor for an OSC 22 shape. The text shape is the terminal's own
 * default, so it clears any program-set cursor.
 */
export function pointerCursor(shape: GhosttyPointerShape): string {
  return shape === "text" ? "" : shape;
}

export type TerminalIntegrationContext = {
  readonly leafId: number;
  /** The pane is visible, focused and the window has focus. */
  readonly userIsLooking: () => boolean;
  /** Writes bytes to the program (terminal replies). */
  readonly reply: (bytes: Uint8Array) => void;
  /** Answers a held Kitty clipboard read of this pane's terminal. */
  readonly answerKittyClipboardRead: (
    id: number,
    answer: OarlockGhosttyKittyClipboardAnswer,
  ) => void;
  /** Where the program-set pointer shape applies. */
  readonly pointerTarget: () => HTMLElement | null;
};

function behavior(): TerminalBehavior {
  return usePreferencesStore.getState().terminalBehavior;
}

let bellAudio: AudioContext | null = null;

/** A short, quiet beep (no asset to load). */
function playBell(): void {
  try {
    bellAudio ??= new AudioContext();
    const oscillator = bellAudio.createOscillator();
    const gain = bellAudio.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, bellAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      bellAudio.currentTime + 0.15,
    );
    oscillator.connect(gain).connect(bellAudio.destination);
    oscillator.start();
    oscillator.stop(bellAudio.currentTime + 0.15);
  } catch {
    /* audio unavailable */
  }
}

/** Asks the OS to draw attention to the window (dock bounce, taskbar flash). */
async function requestWindowAttention(): Promise<void> {
  try {
    const { getCurrentWindow, UserAttentionType } = await import(
      "@tauri-apps/api/window"
    );
    await getCurrentWindow().requestUserAttention(
      UserAttentionType.Informational,
    );
  } catch {
    /* not in Tauri, or not permitted */
  }
}

/**
 * Callbacks that turn a pane's terminal events into app behaviour: tab title
 * and progress, bell marks and sound, desktop notifications (OSC 9/777 and
 * long commands), the program's pointer shape and consented clipboard reads
 * (OSC 52, Kitty OSC 5522).
 */
export function terminalIntegrationCallbacks(
  context: TerminalIntegrationContext,
): GhosttySemanticEventCallbacks {
  const status = () => useTerminalStatusStore.getState();
  let commandStartedAt: number | null = null;
  let command: string | null = null;

  return {
    onTitle: (title) => {
      status().update(context.leafId, { title: title.trim() || null });
    },
    onBell: () => {
      if (behavior().bellSound) playBell();
      if (context.userIsLooking()) return;
      status().update(context.leafId, { bell: true });
      if (!document.hasFocus()) void requestWindowAttention();
    },
    onNotification: (title, body) => {
      if (!behavior().desktopNotifications) return;
      void osNotify(title || "Terminal", body);
    },
    onProgress: (progress: TerminalProgress | null) => {
      status().update(context.leafId, { progress });
    },
    onPointerShape: (shape) => {
      const target = context.pointerTarget();
      if (target) target.style.cursor = pointerCursor(shape);
    },
    onClipboardRead: (selection, terminator) => {
      void answerClipboardRead(context, selection, terminator);
    },
    onKittyClipboardRead: (request) => {
      void answerKittyClipboardRead(context, request);
    },
    onCommandStarted: (text) => {
      commandStartedAt = performance.now();
      command = text;
      status().update(context.leafId, { running: true });
    },
    onCommandFinished: (exitCode) => {
      status().update(context.leafId, { running: false, progress: null });
      if (commandStartedAt === null) return;
      const durationMs = performance.now() - commandStartedAt;
      commandStartedAt = null;
      const settings = behavior();
      if (
        shouldNotifyCommandFinished(
          settings.notifyOnCommandFinish,
          settings.notifyAfterSeconds,
          durationMs,
          context.userIsLooking(),
        )
      ) {
        const message = commandFinishedMessage(command, exitCode, durationMs);
        void osNotify(message.title, message.body);
        if (!document.hasFocus()) void requestWindowAttention();
      }
    },
  };
}

/**
 * Reads reach here only while the setting asks or allows
 * (`kittyClipboardPolicy`); denied ones the core refuses itself.
 */
async function answerKittyClipboardRead(
  context: TerminalIntegrationContext,
  request: KittyClipboardReadRequest,
): Promise<void> {
  // A listing alone shows only the types on offer; Kitty serves it unasked,
  // as it does a read with a paste event's password (the user pasted).
  const program = promptProgramName(request.name);
  const allowed =
    request.mimes.length === 0 ||
    request.granted ||
    behavior().clipboardRead === "allow" ||
    (await requestTerminalPrompt({
      kind: "clipboard-read",
      ...(program ? { program } : {}),
    })) === "allow";
  if (!allowed) {
    context.answerKittyClipboardRead(request.id, { status: "denied" });
    return;
  }
  // The image is read (and encoded) only when it is asked for or listed.
  const image =
    !request.primary && (request.list || request.mimes.includes(IMAGE_MIME));
  const [text, png] = await Promise.all([
    request.primary ? readPrimarySelection() : readTerminalClipboard(),
    image ? readClipboardImage() : null,
  ]);
  context.answerKittyClipboardRead(
    request.id,
    kittyClipboardAnswer(request.mimes, text, png),
  );
}

/**
 * The name a program gives itself, fit for the consent prompt: without
 * control or formatting characters (a bidi override could disguise it), and
 * at most 64 characters.
 */
export function promptProgramName(name: string): string {
  const visible = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return visible.length > 64 ? `${visible.slice(0, 63)}…` : visible;
}

/** The core's Kitty clipboard policy for the clipboard-read setting. */
export function kittyClipboardPolicy(
  access: TerminalBehavior["clipboardRead"],
): GhosttyClipboardPolicy {
  // Writes are allowed as OSC 52 writes are.
  return { readsToHost: access !== "deny", writesAllowed: true };
}

async function answerClipboardRead(
  context: TerminalIntegrationContext,
  selection: string,
  terminator: "st" | "bel",
): Promise<void> {
  const access = behavior().clipboardRead;
  const allowed =
    access === "allow" ||
    (access === "ask" &&
      (await requestTerminalPrompt({ kind: "clipboard-read" })) === "allow");
  // A denied read is answered empty so the program does not wait for it.
  const text = allowed
    ? selection === "p"
      ? ((await readPrimarySelection()) ?? "")
      : selection === "c" || selection === "s" || selection === ""
        ? await readTerminalClipboard()
        : ""
    : "";
  context.reply(
    encoder.encode(clipboardReadReply(selection, text, terminator)),
  );
}
