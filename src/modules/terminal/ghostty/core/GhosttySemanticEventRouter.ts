import type {
  GhosttyPointerShape,
  GhosttyTerminalEvent,
} from "@oarlock/ghostty-core/protocol";
import type { TerminalClipboardContent } from "../../lib/terminalClipboard";
import type { TerminalProgress } from "../../lib/terminalStatus";
import { parseOsc7, parseOsc52Clipboard } from "../../lib/osc-handlers";

export type KittyClipboardReadRequest = Extract<
  GhosttyTerminalEvent,
  { type: "kitty-clipboard-read" }
>;

export type GhosttySemanticEventCallbacks = {
  readonly onBell?: () => void;
  readonly onClipboard?: (text: string) => void;
  readonly onCommandState?: (running: boolean) => void;
  readonly onCwd?: (cwd: string) => void;
  readonly onNotification?: (title: string, body: string) => void;
  readonly onOverflow?: (dropped: number) => void;
  readonly onTitle?: (title: string) => void;
  /** OSC 9;4; null when the program removed its progress. */
  readonly onProgress?: (progress: TerminalProgress | null) => void;
  readonly onPointerShape?: (shape: GhosttyPointerShape) => void;
  /** OSC 52 read request; answer on the PTY with the same terminator. */
  readonly onClipboardRead?: (
    selection: string,
    terminator: "st" | "bel",
  ) => void;
  /** Kitty clipboard read held for the host; answer through the model. */
  readonly onKittyClipboardRead?: (request: KittyClipboardReadRequest) => void;
  /**
   * Kitty clipboard write: what to put there, an image over text (empty
   * text clears it). The primary selection takes text only.
   */
  readonly onKittyClipboardWrite?: (
    content: TerminalClipboardContent,
    primary: boolean,
  ) => void;
  /** The shell started a command (its text when semantic markers report it). */
  readonly onCommandStarted?: (command: string | null) => void;
  /** The running command finished; null when the shell sent no exit code. */
  readonly onCommandFinished?: (exitCode: number | null) => void;
};

/**
 * Routes parser-owned semantic events into Oarlock product callbacks.
 *
 * OSC 7 is accepted only between commands. Output produced by a command is
 * untrusted and must not be allowed to change the workspace directory.
 */
export class GhosttySemanticEventRouter {
  private inCommand = false;

  constructor(private readonly callbacks: GhosttySemanticEventCallbacks) {}

  handle(event: GhosttyTerminalEvent): void {
    switch (event.type) {
      case "bell":
        this.callbacks.onBell?.();
        break;
      case "title":
        this.callbacks.onTitle?.(event.title);
        break;
      case "pwd": {
        if (this.inCommand) break;
        const cwd = parseOsc7(event.uri);
        if (cwd) this.callbacks.onCwd?.(cwd);
        break;
      }
      case "clipboard": {
        const text = parseOsc52Clipboard(`${event.selection};${event.data}`);
        if (text !== null) this.callbacks.onClipboard?.(text);
        break;
      }
      case "notification":
        this.callbacks.onNotification?.(event.title, event.body);
        break;
      case "progress":
        this.callbacks.onProgress?.(
          event.state === "remove"
            ? null
            : { state: event.state, value: event.progress },
        );
        break;
      case "pointer-shape":
        this.callbacks.onPointerShape?.(event.shape);
        break;
      case "clipboard-read":
        this.callbacks.onClipboardRead?.(event.selection, event.terminator);
        break;
      case "kitty-clipboard-read":
        this.callbacks.onKittyClipboardRead?.(event);
        break;
      case "kitty-clipboard-write":
        this.callbacks.onKittyClipboardWrite?.(
          kittyWriteContent(event.contents, event.primary),
          event.primary,
        );
        break;
      case "prompt-start":
        this.inCommand = false;
        this.callbacks.onCommandState?.(false);
        break;
      case "prompt-continuation":
        break;
      case "prompt-end":
        this.inCommand = true;
        break;
      case "end-of-input":
        this.inCommand = true;
        this.callbacks.onCommandState?.(true);
        this.callbacks.onCommandStarted?.(event.command || null);
        break;
      case "end-of-command":
        this.inCommand = false;
        this.callbacks.onCommandState?.(false);
        this.callbacks.onCommandFinished?.(event.exitCode);
        break;
      case "overflow":
        this.callbacks.onOverflow?.(event.dropped);
        break;
    }
  }

  reset(): void {
    this.inCommand = false;
  }
}

const textDecoder = new TextDecoder();

/**
 * What a Kitty clipboard write puts on the clipboard. The core passes its
 * first text and first image; the clipboard holds one, so the image wins,
 * its text kept for should it not decode. No contents clear the clipboard.
 */
function kittyWriteContent(
  contents: Extract<
    GhosttyTerminalEvent,
    { type: "kitty-clipboard-write" }
  >["contents"],
  primary: boolean,
): TerminalClipboardContent {
  const textContent = contents.find(
    (content) => !content.mime.toLowerCase().startsWith("image/"),
  );
  const text = textContent ? textDecoder.decode(textContent.data) : "";
  const image = primary
    ? undefined
    : contents.find((content) => content.mime.toLowerCase().startsWith("image/"));
  if (!image) return text;
  return textContent
    ? { mime: image.mime, data: image.data, text }
    : { mime: image.mime, data: image.data };
}
