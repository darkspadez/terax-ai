import type { TerminalOptionAsAlt } from "@/modules/settings/terminalBehavior";
import {
  isInputMethodKeyDown,
  terminalClipboardAction,
  terminalReadlineSequence,
  type TerminalPlatform,
} from "@/modules/terminal/lib/keymap";
import { readTerminalClipboard } from "@/modules/terminal/lib/terminalClipboard";
import {
  Key,
  KeyAction,
  Mods,
  type KeyEvent,
} from "@terax/ghostty-core/protocol";
import type { GhosttyTerminalModelApi } from "../GhosttyTerminalModel";
import { encodeTerminalPaste, isUnsafePaste } from "./terminalInputEncoding";

import { TerminalInputProxy } from "@/modules/terminal/ghostty/input/TerminalInputProxy";
import { TerminalNativeSelection } from "@/modules/terminal/ghostty/input/TerminalNativeSelection";

/**
 * One keystroke can deliver its text twice, by different events: a prevented
 * keydown and a stray beforeinput, or compositionend and insertText. The
 * second copy is dropped when it comes within this window and before the
 * next keydown; a new keystroke always types.
 */
const DUPLICATE_INPUT_WINDOW_MS = 75;

/** `WheelEvent.deltaMode` values (the constructor is not available everywhere). */
const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** `MouseEvent.button` to Ghostty's buttons: left, middle, right, back, forward. */
const MOUSE_BUTTONS: readonly number[] = [1, 3, 2, 8, 9];

const KEY_MAP: Readonly<Record<string, Key>> = {
  KeyA: Key.A,
  KeyB: Key.B,
  KeyC: Key.C,
  KeyD: Key.D,
  KeyE: Key.E,
  KeyF: Key.F,
  KeyG: Key.G,
  KeyH: Key.H,
  KeyI: Key.I,
  KeyJ: Key.J,
  KeyK: Key.K,
  KeyL: Key.L,
  KeyM: Key.M,
  KeyN: Key.N,
  KeyO: Key.O,
  KeyP: Key.P,
  KeyQ: Key.Q,
  KeyR: Key.R,
  KeyS: Key.S,
  KeyT: Key.T,
  KeyU: Key.U,
  KeyV: Key.V,
  KeyW: Key.W,
  KeyX: Key.X,
  KeyY: Key.Y,
  KeyZ: Key.Z,
  Digit0: Key.ZERO,
  Digit1: Key.ONE,
  Digit2: Key.TWO,
  Digit3: Key.THREE,
  Digit4: Key.FOUR,
  Digit5: Key.FIVE,
  Digit6: Key.SIX,
  Digit7: Key.SEVEN,
  Digit8: Key.EIGHT,
  Digit9: Key.NINE,
  Backquote: Key.GRAVE,
  Backslash: Key.BACKSLASH,
  BracketLeft: Key.BRACKET_LEFT,
  BracketRight: Key.BRACKET_RIGHT,
  Comma: Key.COMMA,
  Equal: Key.EQUAL,
  IntlBackslash: Key.INTL_BACKSLASH,
  Minus: Key.MINUS,
  Period: Key.PERIOD,
  Quote: Key.QUOTE,
  Semicolon: Key.SEMICOLON,
  Slash: Key.SLASH,
  Backspace: Key.BACKSPACE,
  Enter: Key.ENTER,
  Space: Key.SPACE,
  Tab: Key.TAB,
  Delete: Key.DELETE,
  End: Key.END,
  Home: Key.HOME,
  Insert: Key.INSERT,
  PageDown: Key.PAGE_DOWN,
  PageUp: Key.PAGE_UP,
  ArrowDown: Key.DOWN,
  ArrowLeft: Key.LEFT,
  ArrowRight: Key.RIGHT,
  ArrowUp: Key.UP,
  Escape: Key.ESCAPE,
  F1: Key.F1,
  F2: Key.F2,
  F3: Key.F3,
  F4: Key.F4,
  F5: Key.F5,
  F6: Key.F6,
  F7: Key.F7,
  F8: Key.F8,
  F9: Key.F9,
  F10: Key.F10,
  F11: Key.F11,
  F12: Key.F12,
  F13: Key.F13,
  F14: Key.F14,
  F15: Key.F15,
  F16: Key.F16,
  F17: Key.F17,
  F18: Key.F18,
  F19: Key.F19,
  F20: Key.F20,
  F21: Key.F21,
  F22: Key.F22,
  F23: Key.F23,
  F24: Key.F24,
  Numpad0: Key.KP_0,
  Numpad1: Key.KP_1,
  Numpad2: Key.KP_2,
  Numpad3: Key.KP_3,
  Numpad4: Key.KP_4,
  Numpad5: Key.KP_5,
  Numpad6: Key.KP_6,
  Numpad7: Key.KP_7,
  Numpad8: Key.KP_8,
  Numpad9: Key.KP_9,
  NumpadAdd: Key.KP_PLUS,
  NumpadDecimal: Key.KP_PERIOD,
  NumpadDivide: Key.KP_DIVIDE,
  NumpadEnter: Key.KP_ENTER,
  NumpadEqual: Key.KP_EQUAL,
  NumpadMultiply: Key.KP_MULTIPLY,
  NumpadSubtract: Key.KP_MINUS,
  AltLeft: Key.ALT_LEFT,
  AltRight: Key.ALT_RIGHT,
  ControlLeft: Key.CONTROL_LEFT,
  ControlRight: Key.CONTROL_RIGHT,
  MetaLeft: Key.META_LEFT,
  MetaRight: Key.META_RIGHT,
  ShiftLeft: Key.SHIFT_LEFT,
  ShiftRight: Key.SHIFT_RIGHT,
};

type InputSource = "keydown" | "beforeinput" | "composition" | "paste";

export type GhosttyInputControllerOptions = {
  readonly model: GhosttyTerminalModelApi;
  readonly input: HTMLTextAreaElement;
  readonly pointerTarget: HTMLElement;
  readonly cellSize: () => { width: number; height: number };
  /** CSS pixels the drawn grid is moved up inside the pointer target; zero when absent. */
  readonly gridShiftY?: () => number;
  readonly onData: (bytes: Uint8Array) => void;
  /**
   * Copies the selection; false when nothing is selected, and the key goes
   * on to the program. `clearSelection` asks for the copied selection to be
   * cleared, so pressing the key again (Ctrl+C) interrupts.
   */
  readonly onCopy: (clearSelection: boolean) => boolean;
  readonly getSelection?: () => string | null;
  readonly onPaste?: (text: string) => boolean;
  readonly onText?: (text: string) => boolean;
  readonly onKeyDown?: (event: KeyboardEvent) => boolean;
  /** macOS: which Option key types Alt (ESC-prefixed) instead of composing. */
  readonly optionAsAlt?: () => TerminalOptionAsAlt;
  /** Lines per wheel notch (default 3); pixel deltas scale relative to 3. */
  readonly scrollMultiplier?: () => number;
  /**
   * Asked before a paste that could run commands (see `isUnsafePaste`);
   * resolves true to paste. Without it every paste goes through.
   */
  readonly confirmPaste?: (text: string) => Promise<boolean>;
  /** A left-button selection gesture ended (copy-on-select). */
  readonly onSelectionFinished?: () => void;
  /** Middle click the program does not track; true when handled (a paste). */
  readonly onMiddleClick?: () => boolean;
  /**
   * Whether the clipboard holds an image: a Kitty paste event then offers it
   * as `image/png`, and a paste key with no text sends the program Ctrl+V.
   */
  readonly clipboardHasImage?: () => Promise<boolean>;
  readonly isMac?: boolean;
  readonly isWindows?: boolean;
  /** Windows: plain Ctrl+C copies a selection and Ctrl+V pastes. */
  readonly smartCopyPaste?: () => boolean;
  /** Selected-placeholder input proxy (a macOS WebKit fix); defaults to `isMac`. */
  readonly inputPlaceholder?: boolean;
};

export class GhosttyInputController {
  private readonly encoder = new TextEncoder();
  private readonly isMac: boolean;
  private readonly platform: TerminalPlatform;
  private readonly proxy: TerminalInputProxy;
  private readonly nativeSelection: TerminalNativeSelection | null;
  private readonly pressedKeys = new Map<string, KeyEvent>();
  private composing = false;
  private mouseButtons = 0;
  private lastData = "";
  private lastSource: InputSource | null = null;
  private lastDataAt = 0;
  private wheelRemainderX = 0;
  private wheelRemainderY = 0;
  /** Option keys held, by side (macOS Option-as-Alt is per side). */
  private readonly optionKeys = new Set<"AltLeft" | "AltRight">();
  private disposed = false;

  constructor(private readonly options: GhosttyInputControllerOptions) {
    this.isMac = options.isMac ?? /Mac|iPhone|iPad/.test(navigator.userAgent);
    this.platform = this.isMac
      ? "macos"
      : (options.isWindows ?? /Windows/.test(navigator.userAgent))
        ? "windows"
        : "linux";
    this.proxy = new TerminalInputProxy(options.input, {
      placeholder: options.inputPlaceholder ?? this.isMac,
    });
    this.nativeSelection = options.getSelection
      ? new TerminalNativeSelection({
          proxy: this.proxy,
          input: options.input,
          target: options.pointerTarget,
          getSelection: options.getSelection,
          mouseTracking: () => options.model.modes().mouseTracking,
          isMac: this.isMac,
        })
      : null;
    options.input.addEventListener("keydown", this.handleKeyDown);
    options.input.addEventListener("keyup", this.handleKeyUp);
    options.input.addEventListener("beforeinput", this.handleBeforeInput);
    options.input.addEventListener(
      "compositionstart",
      this.handleCompositionStart,
    );
    options.input.addEventListener("compositionend", this.handleCompositionEnd);
    options.input.addEventListener("paste", this.handlePaste);
    options.input.addEventListener("focus", this.handleFocus);
    options.input.addEventListener("blur", this.handleBlur);
    options.pointerTarget.addEventListener("mousedown", this.handleMouseDown);
    options.pointerTarget.addEventListener("mouseup", this.handleMouseUp);
    options.pointerTarget.addEventListener("mousemove", this.handleMouseMove);
    options.pointerTarget.addEventListener("mouseleave", this.handleMouseLeave);
    options.pointerTarget.addEventListener("pointerup", this.handlePointerUp);
    options.pointerTarget.addEventListener("wheel", this.handleWheel, {
      passive: false,
    });
  }

  /** Text inserted other than from a clipboard (drops, scripted input). */
  paste(text: string): void {
    this.deliverPaste(text, null);
  }

  /**
   * A paste the user made from a clipboard (shortcut, menu, middle click):
   * a program that set mode 5522 is sent a Kitty paste event and reads the
   * clipboard itself; anything else gets the text.
   */
  pasteFromClipboard(text: string, primary = false): void {
    this.deliverPaste(text, primary);
  }

  private deliverPaste(text: string, clipboard: boolean | null): void {
    if (this.disposed) return;
    // A clipboard holding only an image is pasted as a paste event alone.
    const event =
      clipboard !== null && this.options.model.pasteEventsWanted?.() === true;
    if (!text && !event) return;
    this.nativeSelection?.reset();
    if (text && this.options.onPaste?.(text)) return;
    if (clipboard !== null && event) {
      void this.sendPasteEvent(text, clipboard);
      return;
    }
    this.pasteText(text);
  }

  /**
   * Mode 5522: the program is sent a Kitty paste event listing what the
   * clipboard holds, an image included, and reads it itself; the text is
   * pasted when no event could be sent.
   */
  private async sendPasteEvent(text: string, primary: boolean): Promise<void> {
    const image =
      !primary &&
      (await this.options.clipboardHasImage?.().catch(() => false)) === true;
    if (this.disposed || this.options.model.isDisposed?.()) return;
    const mimes = text ? ["text/plain"] : [];
    if (image) mimes.push("image/png");
    if (mimes.length > 0 && this.options.model.sendPasteEvent?.(primary, mimes))
      return;
    if (text) this.pasteText(text);
  }

  private pasteText(text: string): void {
    const bracketed = this.options.model.modes().bracketedPaste;
    if (this.options.confirmPaste && isUnsafePaste(text, bracketed)) {
      void this.options.confirmPaste(text).then((confirmed) => {
        // Bracketed paste may have changed while the user decided.
        if (confirmed && !this.disposed) {
          this.emitText(
            encodeTerminalPaste(text, this.options.model.modes().bracketedPaste),
            "paste",
            false,
          );
        }
      });
      return;
    }
    this.emitText(encodeTerminalPaste(text, bracketed), "paste", false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.nativeSelection?.dispose();
    this.proxy.dispose();
    this.pressedKeys.clear();
    const { input, pointerTarget } = this.options;
    input.removeEventListener("keydown", this.handleKeyDown);
    input.removeEventListener("keyup", this.handleKeyUp);
    input.removeEventListener("beforeinput", this.handleBeforeInput);
    input.removeEventListener("compositionstart", this.handleCompositionStart);
    input.removeEventListener("compositionend", this.handleCompositionEnd);
    input.removeEventListener("paste", this.handlePaste);
    input.removeEventListener("focus", this.handleFocus);
    input.removeEventListener("blur", this.handleBlur);
    pointerTarget.removeEventListener("mousedown", this.handleMouseDown);
    pointerTarget.removeEventListener("mouseup", this.handleMouseUp);
    pointerTarget.removeEventListener("mousemove", this.handleMouseMove);
    pointerTarget.removeEventListener("mouseleave", this.handleMouseLeave);
    pointerTarget.removeEventListener("pointerup", this.handlePointerUp);
    pointerTarget.removeEventListener("wheel", this.handleWheel);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    this.nativeSelection?.reset();
    // A new keystroke: its text is never a copy of the previous one's.
    this.lastData = "";
    this.lastSource = null;
    if (event.code === "AltLeft" || event.code === "AltRight") {
      this.optionKeys.add(event.code);
    }
    if (!event.defaultPrevented && !this.composing && this.optionTypesAlt(event)) {
      if (this.encodeOptionAsAlt(event)) {
        consume(event);
        return;
      }
    }
    if (event.defaultPrevented || isInputMethodKeyDown(event, this.composing))
      return;

    const clipboard = terminalClipboardAction(event, {
      platform: this.platform,
      smartCopyPaste: this.options.smartCopyPaste?.() ?? false,
    });
    if (clipboard === "paste" || clipboard === "pasteText") {
      consume(event);
      void readTerminalClipboard().then(async (text) => {
        if (text || this.options.model.pasteEventsWanted?.()) {
          this.pasteFromClipboard(text);
        } else if (clipboard === "pasteText") {
          // No text: the program gets the key and reads the clipboard
          // itself (agents paste an image on Ctrl+V).
          this.sendHeldKey(event);
        } else if (
          (await this.options.clipboardHasImage?.().catch(() => false)) ===
          true
        ) {
          // Only an image: agents (Claude Code, Codex) read it themselves
          // when they get Ctrl+V.
          this.sendControlV();
        }
      });
      return;
    }
    if (
      (clipboard === "copy" || clipboard === "copyAndClear") &&
      this.options.onCopy(clipboard === "copyAndClear")
    ) {
      consume(event);
      return;
    }

    if (this.options.onKeyDown?.(event)) {
      consume(event);
      return;
    }

    const readline = terminalReadlineSequence(event, {
      isMac: this.isMac,
      isAlternateScreen: this.options.model.modes().alternateScreen,
    });
    if (readline) {
      consume(event);
      this.emitText(readline, "keydown");
      return;
    }
    // Unclaimed Command shortcuts belong to the native menu, even in Kitty mode.
    if (this.isMac && event.metaKey) return;
    if (
      event.key === "Enter" &&
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      consume(event);
      // A program in Kitty or modifyOtherKeys mode reads Shift+Enter in its
      // own encoding (CSI 13;2u). Elsewhere ESC CR stands for it: agents and
      // line editors read it as "insert a newline", where Ghostty's legacy
      // CSI 27;2;13~ would type junk into a plain shell.
      if (!this.options.model.enhancedKeyboard?.()) {
        this.emitText("\x1b\r", "keydown");
        return;
      }
      const encoded = this.encodeKeyDown(event, Key.ENTER);
      if (encoded.byteLength > 0) {
        this.options.model.scrollToBottom();
        this.options.onData(encoded);
      }
      return;
    }

    const printable =
      event.key.length === 1 &&
      !event.metaKey &&
      ((!event.ctrlKey && !event.altKey) ||
        (event.ctrlKey && event.altKey) ||
        // Option composes characters on macOS unless it types Alt (above).
        (this.isMac && event.altKey && !event.ctrlKey));
    if (printable) {
      consume(event);
      this.emitText(
        event.key,
        "keydown",
        true,
        true,
        true,
        !event.altKey && KEY_MAP[event.code] !== undefined ? event : undefined,
      );
      return;
    }

    const key = KEY_MAP[event.code];
    if (key === undefined) return;
    const encoded = this.encodeKeyDown(event, key);
    if (encoded.byteLength > 0) {
      consume(event);
      this.options.model.scrollToBottom();
      this.options.onData(encoded);
    }
  };

  private encodeKeyDown(event: KeyboardEvent, key: Key): Uint8Array {
    const utf8 = event.key.length === 1 ? event.key : undefined;
    const data = {
      action: event.repeat ? KeyAction.REPEAT : KeyAction.PRESS,
      key,
      mods: modifiers(event),
      consumedMods: consumedModifiers(event, utf8),
      utf8,
      unshiftedCodepoint: unshiftedCodepoint(event),
    };
    const encoded = this.options.model.encodeKey(data);
    if (encoded.byteLength > 0) this.pressedKeys.set(event.code, data);
    return encoded;
  }

  /** Sends a key whose keydown was held back for an asynchronous decision. */
  private sendHeldKey(event: KeyboardEvent): void {
    const key = KEY_MAP[event.code];
    if (this.disposed || this.options.model.isDisposed?.() || key === undefined)
      return;
    const encoded = this.encodeKeyDown(event, key);
    if (encoded.byteLength === 0) return;
    this.options.model.scrollToBottom();
    this.emitBytes(encoded);
  }

  /** Ctrl+V pressed and released, encoded as the program asked (^V, `CSI 118;5u`). */
  private sendControlV(): void {
    if (this.disposed || this.options.model.isDisposed?.()) return;
    const press: KeyEvent = {
      action: KeyAction.PRESS,
      key: Key.V,
      mods: Mods.CTRL,
      utf8: "v",
      unshiftedCodepoint: 118,
    };
    const pressed = this.options.model.encodeKey(press);
    const released = this.options.model.encodeKey({
      ...press,
      action: KeyAction.RELEASE,
      utf8: undefined,
    });
    if (pressed.byteLength === 0) return;
    this.options.model.scrollToBottom();
    this.emitBytes(pressed);
    if (released.byteLength > 0) this.emitBytes(released);
  }

  /** macOS Option-as-Alt applies to this key event (side-aware). */
  private optionTypesAlt(event: KeyboardEvent): boolean {
    if (!this.isMac || !event.altKey || event.ctrlKey || event.metaKey) return false;
    const setting = this.options.optionAsAlt?.() ?? "off";
    if (setting === "off") return false;
    if (setting === "both") return true;
    // Without a tracked press (focus arrived with Option held), assume left.
    const side =
      this.optionKeys.has("AltRight") && !this.optionKeys.has("AltLeft")
        ? "right"
        : "left";
    return setting === side;
  }

  /**
   * Option as Alt: encodes the character the key types without Option (from
   * its physical position, US layout), with the Alt modifier, so readline and
   * editors see ESC-prefixed or Kitty-encoded Alt instead of a composed
   * character such as "ƒ".
   */
  private encodeOptionAsAlt(event: KeyboardEvent): boolean {
    const key = KEY_MAP[event.code];
    const text = baseCharacter(event);
    if (key === undefined || !text) return false;
    const data = {
      action: event.repeat ? KeyAction.REPEAT : KeyAction.PRESS,
      key,
      mods: modifiers(event),
      consumedMods: consumedModifiers(event, text),
      utf8: text,
      unshiftedCodepoint:
        baseCharacter({ code: event.code, shiftKey: false }).codePointAt(0) ??
        0,
    };
    const encoded = this.options.model.encodeKey(data);
    if (encoded.byteLength === 0) return false;
    this.pressedKeys.set(event.code, data);
    this.options.model.scrollToBottom();
    this.options.onData(encoded);
    return true;
  }

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "AltLeft" || event.code === "AltRight") {
      this.optionKeys.delete(event.code);
    }
    const pressed = this.pressedKeys.get(event.code);
    if (!pressed) return;
    this.pressedKeys.delete(event.code);
    if (event.defaultPrevented || this.composing || event.isComposing) return;
    const encoded = this.options.model.encodeKey({
      ...pressed,
      action: KeyAction.RELEASE,
      mods: modifiers(event),
      utf8: undefined,
    });
    if (encoded.byteLength > 0) {
      consume(event);
      this.options.onData(encoded);
    }
  };

  private readonly handleBeforeInput = (event: InputEvent): void => {
    if (this.composing || event.isComposing) return;
    let data: string | null = null;
    switch (event.inputType) {
      case "insertText":
      case "insertReplacementText":
        data = event.data;
        break;
      case "insertLineBreak":
      case "insertParagraph":
        data = "\r";
        break;
      case "deleteContentBackward":
        data = "\x7f";
        break;
      case "deleteContentForward":
        data = "\x1b[3~";
        break;
      case "insertFromPaste":
        if (event.data) this.pasteFromClipboard(event.data);
        consume(event);
        return;
      default:
        return;
    }
    if (!data) return;
    consume(event);
    this.emitText(
      data,
      "beforeinput",
      true,
      true,
      event.inputType === "insertText" ||
        event.inputType === "insertReplacementText",
    );
    this.proxy.arm();
  };

  private readonly handleCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly handleCompositionEnd = (event: CompositionEvent): void => {
    this.composing = false;
    if (event.data) this.emitText(event.data, "composition", true, true, true);
    this.proxy.arm();
  };

  private readonly handlePaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    // An image alone is pasted only as a paste event (mode 5522).
    if (
      !text &&
      !(
        this.options.model.pasteEventsWanted?.() &&
        event.clipboardData?.types?.some((type) =>
          type.toLowerCase().startsWith("image/"),
        )
      )
    )
      return;
    consume(event);
    this.pasteFromClipboard(text);
  };

  private readonly handleFocus = (): void => {
    if (this.options.model.modes().focusReporting) {
      this.emitText("\x1b[I", "keydown", false, false);
    }
  };

  private readonly handleBlur = (): void => {
    this.pressedKeys.clear();
    this.optionKeys.clear();
    this.composing = false;
    if (this.options.model.modes().focusReporting) {
      this.emitText("\x1b[O", "keydown", false, false);
    }
  };

  private readonly handleMouseDown = (event: MouseEvent): void => {
    if (!this.reportsMouse(event)) {
      if (event.button === 1 && this.options.onMiddleClick?.()) consume(event);
      return;
    }
    const button = MOUSE_BUTTONS[event.button];
    if (button === undefined) return;
    this.mouseButtons |= 1 << event.button;
    if (this.sendMouse("press", button, event)) consume(event);
  };

  private readonly handleMouseUp = (event: MouseEvent): void => {
    const held = (this.mouseButtons & (1 << event.button)) !== 0;
    this.mouseButtons &= ~(1 << event.button);
    // A release is reported for a press that was, even if tracking just ended.
    if (!held && !this.reportsMouse(event)) return;
    const button = MOUSE_BUTTONS[event.button];
    if (button === undefined) return;
    if (this.sendMouse("release", button, event)) consume(event);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || this.reportsMouse(event)) return;
    // The selection controller finished the selection on this same event.
    this.options.onSelectionFinished?.();
  };

  private readonly handleMouseMove = (event: MouseEvent): void => {
    if (!this.reportsMouse(event)) return;
    let button = 0;
    for (let index = 0; index < MOUSE_BUTTONS.length; index += 1) {
      if ((this.mouseButtons & (1 << index)) !== 0) {
        button = MOUSE_BUTTONS[index] ?? 0;
        break;
      }
    }
    // The encoder reports motion only in modes 1002/1003, once per cell.
    if (this.sendMouse("motion", button, event)) consume(event);
  };

  private readonly handleMouseLeave = (): void => {
    this.options.model.resetMouseMotion?.();
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    const cell = this.options.cellSize();
    if (cell.width <= 0 || cell.height <= 0) return;
    const multiplier = this.options.scrollMultiplier?.() ?? 3;
    // Trackpads and most mice report pixels: scroll by distance, scaled by
    // the multiplier relative to its default of 3 lines per notch.
    const scale =
      event.deltaMode === DOM_DELTA_LINE
        ? multiplier
        : event.deltaMode === DOM_DELTA_PAGE
          ? this.options.model.rows
          : multiplier / 3;
    const pixel = event.deltaMode === DOM_DELTA_PIXEL;
    this.wheelRemainderY += pixel
      ? (event.deltaY / cell.height) * scale
      : event.deltaY * scale;
    this.wheelRemainderX += pixel
      ? (event.deltaX / cell.width) * scale
      : event.deltaX * scale;
    const rows = Math.trunc(this.wheelRemainderY);
    const columns = Math.trunc(this.wheelRemainderX);
    this.wheelRemainderY -= rows;
    this.wheelRemainderX -= columns;

    if (this.reportsMouse(event)) {
      consume(event);
      for (let step = 0; step < Math.abs(rows); step += 1) {
        this.sendMouse("press", rows < 0 ? 4 : 5, event);
      }
      for (let step = 0; step < Math.abs(columns); step += 1) {
        this.sendMouse("press", columns < 0 ? 6 : 7, event);
      }
      return;
    }

    const modes = this.options.model.modes();
    // Alternate scroll (mode 1007, on by default): a full-screen program that
    // does not track the mouse gets cursor keys, so pagers and editors scroll.
    if (modes.alternateScreen && this.options.model.mode(1007)) {
      consume(event);
      for (let step = 0; step < Math.abs(rows); step += 1) {
        const bytes = this.options.model.encodeKey({
          action: KeyAction.PRESS,
          key: rows < 0 ? Key.UP : Key.DOWN,
          mods: Mods.NONE,
        });
        if (bytes.byteLength > 0) this.options.onData(bytes);
      }
      return;
    }

    if (this.options.model.scrollPosition().history === 0) return;
    if (rows !== 0) this.options.model.scrollBy(rows);
    consume(event);
  };

  /** Mouse events go to the program: it tracks the mouse and Shift is up. */
  private reportsMouse(event: MouseEvent): boolean {
    return this.options.model.modes().mouseTracking && !event.shiftKey;
  }

  /** Grid-relative position in the terminal pixels the core counts in. */
  private terminalPosition(event: MouseEvent): { x: number; y: number } | null {
    const rect = this.options.pointerTarget.getBoundingClientRect();
    const cell = this.options.cellSize();
    if (cell.width <= 0 || cell.height <= 0) return null;
    const pixels = this.options.model.cellPixelSize?.() ?? cell;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top + (this.options.gridShiftY?.() ?? 0);
    return {
      x: (x / cell.width) * pixels.width,
      y: (y / cell.height) * pixels.height,
    };
  }

  /** Encodes and sends one mouse event; false when the program skips it. */
  private sendMouse(
    action: "press" | "release" | "motion",
    button: number,
    event: MouseEvent,
  ): boolean {
    const encodeMouse = this.options.model.encodeMouse;
    const position = this.terminalPosition(event);
    if (!encodeMouse || !position) return false;
    const bytes = encodeMouse.call(this.options.model, {
      action,
      button,
      mods: modifiers(event),
      x: position.x,
      y: position.y,
      anyButtonPressed: this.mouseButtons !== 0,
    });
    if (bytes.byteLength === 0) return false;
    this.emitBytes(bytes);
    return true;
  }

  private emitText(
    data: string,
    source: InputSource,
    deduplicate = true,
    scrollToBottom = true,
    editableText = false,
    keyEvent?: KeyboardEvent,
  ): void {
    if (this.disposed) return;
    const now = performance.now();
    if (
      deduplicate &&
      source !== this.lastSource &&
      data === this.lastData &&
      now - this.lastDataAt < DUPLICATE_INPUT_WINDOW_MS
    ) {
      this.lastData = "";
      this.lastSource = null;
      return;
    }
    this.lastData = data;
    this.lastSource = source;
    this.lastDataAt = now;
    if (editableText && this.options.onText?.(data)) return;
    if (scrollToBottom) this.options.model.scrollToBottom();
    const bytes = keyEvent
      ? this.encodeKeyDown(keyEvent, KEY_MAP[keyEvent.code])
      : this.encoder.encode(data);
    if (bytes.byteLength > 0) this.options.onData(bytes);
  }

  /** Program-bound bytes that are not typing (mouse reports). */
  private emitBytes(bytes: Uint8Array): void {
    if (this.disposed) return;
    this.lastData = "";
    this.lastSource = null;
    this.options.onData(bytes);
  }
}

const UNSHIFTED_SYMBOLS: Readonly<Record<string, string>> = {
  Backquote: "`~",
  Backslash: "\\|",
  BracketLeft: "[{",
  BracketRight: "]}",
  Comma: ",<",
  Equal: "=+",
  IntlBackslash: "\\|",
  Minus: "-_",
  Period: ".>",
  Quote: "'\"",
  Semicolon: ";:",
  Slash: "/?",
};

function unshiftedCodepoint(event: KeyboardEvent): number {
  const character = event.key.toLowerCase().codePointAt(0) ?? 0;
  if (event.key.length === 1 && character >= 32 && character !== 127) {
    if (event.shiftKey) {
      const pair = UNSHIFTED_SYMBOLS[event.code];
      if (pair?.[1] === event.key) return pair.charCodeAt(0);
      if (event.code.startsWith("Digit") && event.code.length === 6) {
        const digit = event.code.charCodeAt(5) - 48;
        if (")!@#$%^&*("[digit] === event.key) return digit + 48;
      }
    }
    return character;
  }
  return event.code.startsWith("Key") && event.code.length === 4
    ? event.code.toLowerCase().charCodeAt(3)
    : 0;
}

/**
 * Modifiers used up in typing `text`, as Ghostty's own apprts report them
 * (xkb's consumed modifiers): Shift when it picked the key's shifted level.
 * Kitty modes below report-all then send the text itself (Shift+; types ":"),
 * while report-all still names the unshifted key with Shift (`CSI 59:58;2u`).
 * Space and keypad keys type the same text either way, so Shift stays a
 * modifier there (Shift+Space is `CSI 32;2u`).
 */
function consumedModifiers(
  event: Pick<KeyboardEvent, "code" | "shiftKey">,
  text: string | undefined,
): Mods {
  return event.shiftKey &&
    text !== undefined &&
    text !== "" &&
    event.code !== "Space" &&
    !event.code.startsWith("Numpad")
    ? Mods.SHIFT
    : Mods.NONE;
}

/**
 * The character a key types without Option, from its physical position on a
 * US layout (shifted when Shift is held); "" when it types none.
 */
export function baseCharacter(
  event: Pick<KeyboardEvent, "code" | "shiftKey">,
): string {
  const { code, shiftKey } = event;
  if (code.startsWith("Key") && code.length === 4) {
    const letter = code.charAt(3);
    return shiftKey ? letter : letter.toLowerCase();
  }
  if (code.startsWith("Digit") && code.length === 6) {
    const digit = code.charCodeAt(5) - 48;
    return shiftKey ? (")!@#$%^&*("[digit] ?? "") : String(digit);
  }
  if (code === "Space") return " ";
  const pair = UNSHIFTED_SYMBOLS[code];
  return pair ? pair.charAt(shiftKey ? 1 : 0) : "";
}

function modifiers(
  event: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey"> & {
    readonly getModifierState?: (key: string) => boolean;
  },
): Mods {
  let result = Mods.NONE;
  if (event.shiftKey) result |= Mods.SHIFT;
  if (event.ctrlKey) result |= Mods.CTRL;
  if (event.altKey) result |= Mods.ALT;
  if (event.metaKey) result |= Mods.SUPER;
  if (event.getModifierState?.("CapsLock")) result |= Mods.CAPSLOCK;
  if (event.getModifierState?.("NumLock")) result |= Mods.NUMLOCK;
  return result;
}

function consume(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}
