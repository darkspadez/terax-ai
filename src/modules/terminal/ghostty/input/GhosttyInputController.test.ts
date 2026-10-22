import type { GhosttyTerminalModelApi } from "@/modules/terminal/ghostty/GhosttyTerminalModel";
import { readFile } from "node:fs/promises";
import { TeraxGhostty } from "@terax/ghostty-core/adapted";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, FakeTextArea } from "./fakeTextArea";
import { AdaptedGhosttyTerminalModel } from "../AdaptedGhosttyTerminalModel";
import { baseCharacter, GhosttyInputController } from "./GhosttyInputController";
import { supportedKittyKeyboardFlags } from "./terminalInputEncoding";

describe("baseCharacter", () => {
  it("returns what a key types without Option, by physical position", () => {
    expect(baseCharacter({ code: "KeyF", shiftKey: false })).toBe("f");
    expect(baseCharacter({ code: "KeyF", shiftKey: true })).toBe("F");
    expect(baseCharacter({ code: "Digit2", shiftKey: false })).toBe("2");
    expect(baseCharacter({ code: "Digit2", shiftKey: true })).toBe("@");
    expect(baseCharacter({ code: "Period", shiftKey: false })).toBe(".");
    expect(baseCharacter({ code: "Slash", shiftKey: true })).toBe("?");
    expect(baseCharacter({ code: "Space", shiftKey: false })).toBe(" ");
    expect(baseCharacter({ code: "ArrowLeft", shiftKey: false })).toBe("");
  });
});

describe("GhosttyInputController", () => {
  it.each(["ghostty-vt.wasm", "ghostty-vt-scalar.wasm"])(
    "leaves macOS Command shortcuts to the application in legacy and Kitty modes (%s)",
    async (artifact) => {
      const bytes = await readFile(
        new URL(
          `../../../../../packages/ghostty-core/adapted/${artifact}`,
          import.meta.url,
        ),
      );
      const core = await TeraxGhostty.loadBytes(Uint8Array.from(bytes).buffer);
      const terminal = core.createTerminal(80, 24);
      const input = new FakeTextArea();
      const onData = vi.fn();
      const encodeKey = vi.fn<GhosttyTerminalModelApi["encodeKey"]>((event) =>
        terminal.encodeKey(event),
      );
      const controller = new GhosttyInputController({
        model: { ...inputModel(), encodeKey },
        input: input as unknown as HTMLTextAreaElement,
        pointerTarget: new FakeElement() as unknown as HTMLElement,
        cellSize: () => ({ width: 10, height: 20 }),
        isMac: true,
        onCopy: () => false,
        onData,
      });
      try {
        for (const mode of [0, 1, 11, 31]) {
          terminal.write(new TextEncoder().encode(`\x1b[=${mode}u`));
          for (const values of [
            { key: "q", code: "KeyQ" },
            { key: "h", code: "KeyH" },
            { key: "m", code: "KeyM" },
            { key: "h", code: "KeyH", altKey: true },
            { key: "c", code: "KeyC" },
          ]) {
            for (const type of ["keydown", "keyup"]) {
              const event = keyboardEvent({ ...values, metaKey: true }, type);
              const stopPropagation = vi.spyOn(event, "stopPropagation");
              input.dispatchEvent(event);
              expect(event.defaultPrevented).toBe(false);
              expect(stopPropagation).not.toHaveBeenCalled();
            }
          }
        }
        expect(encodeKey).not.toHaveBeenCalled();
        expect(onData).not.toHaveBeenCalled();
      } finally {
        controller.dispose();
        terminal.dispose();
      }
    },
  );

  it("preserves explicit macOS editing shortcuts and non-macOS Super encoding", () => {
    for (const isMac of [true, false]) {
      const input = new FakeTextArea();
      const onData = vi.fn();
      const onCopy = vi.fn(() => true);
      const encodeKey = vi.fn(() => new Uint8Array([27, 113]));
      const controller = new GhosttyInputController({
        model: { ...inputModel(), encodeKey },
        input: input as unknown as HTMLTextAreaElement,
        pointerTarget: new FakeElement() as unknown as HTMLElement,
        cellSize: () => ({ width: 10, height: 20 }),
        isMac,
        onCopy,
        onData,
      });
      try {
        if (isMac) {
          const copy = keyboardEvent({ key: "c", code: "KeyC", metaKey: true });
          input.dispatchEvent(copy);
          expect(copy.defaultPrevented).toBe(true);
          expect(onCopy).toHaveBeenCalledOnce();
          expect(onData).not.toHaveBeenCalled();
          for (const [key, sequence] of [
            ["ArrowLeft", "\x01"],
            ["ArrowRight", "\x05"],
            ["Backspace", "\x15"],
          ]) {
            const event = keyboardEvent({ key, code: key, metaKey: true });
            input.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
            expect(new TextDecoder().decode(onData.mock.lastCall?.[0])).toBe(
              sequence,
            );
          }
          expect(encodeKey).not.toHaveBeenCalled();
        } else {
          const event = keyboardEvent({
            key: "q",
            code: "KeyQ",
            metaKey: true,
          });
          input.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
          expect(encodeKey).toHaveBeenCalledOnce();
          expect(onData).toHaveBeenCalledWith(new Uint8Array([27, 113]));
        }
      } finally {
        controller.dispose();
      }
    }
  });

  it.each(["ghostty-vt.wasm", "ghostty-vt-scalar.wasm"])(
    "preserves Control through Fish's Kitty keyboard mode (%s)",
    async (artifact) => {
      const bytes = await readFile(
        new URL(
          `../../../../../packages/ghostty-core/adapted/${artifact}`,
          import.meta.url,
        ),
      );
      const core = await TeraxGhostty.loadBytes(Uint8Array.from(bytes).buffer);
      const terminal = core.createTerminal(80, 24);
      const input = new FakeTextArea();
      const onData = vi.fn();
      const controller = new GhosttyInputController({
        model: {
          ...inputModel(),
          encodeKey: (event) => terminal.encodeKey(event),
        },
        input: input as unknown as HTMLTextAreaElement,
        pointerTarget: new FakeElement() as unknown as HTMLElement,
        cellSize: () => ({ width: 10, height: 20 }),
        isMac: true,
        onCopy: () => false,
        onData,
      });
      try {
        terminal.write(new TextEncoder().encode("\x1b[>1u"));
        input.dispatchEvent(
          keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true }),
        );
        expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe(
          "\x1b[99;5u",
        );
        terminal.write(new TextEncoder().encode("\x1b[<u"));
        input.dispatchEvent(
          keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true }),
        );
        expect(onData.mock.calls[1][0]).toEqual(new Uint8Array([3]));
        terminal.write(new TextEncoder().encode("\x1b[>11u"));
        input.dispatchEvent(keyboardEvent({ key: "x", code: "KeyX" }));
        input.dispatchEvent(
          Object.assign(new Event("keyup", { cancelable: true }), {
            key: "x",
            code: "KeyX",
            ctrlKey: false,
            altKey: false,
            metaKey: false,
            shiftKey: false,
            getModifierState: () => false,
          }),
        );
        expect(new TextDecoder().decode(onData.mock.calls[2][0])).toBe(
          "\x1b[120u",
        );
        expect(new TextDecoder().decode(onData.mock.calls[3][0])).toBe(
          "\x1b[120;1:3u",
        );
      } finally {
        controller.dispose();
        terminal.dispose();
      }
    },
  );

  it("routes prompt paste to the command editor without also sending PTY bytes", () => {
    const model = inputModel();
    const onData = vi.fn();
    const onPaste = vi.fn(() => true);
    const controller = new GhosttyInputController({
      model,
      input: new FakeTextArea() as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      isMac: true,
      onCopy: () => false,
      onData,
      onPaste,
    });
    controller.paste("echo text");
    expect(onPaste).toHaveBeenCalledWith("echo text");
    expect(onData).not.toHaveBeenCalled();
    onPaste.mockReturnValue(false);
    controller.paste("process input");
    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe(
      "process input",
    );
    controller.dispose();
  });

  it("routes keys and composed text back to the prompt after a native menu", () => {
    const input = new FakeTextArea();
    const onKeyDown = vi.fn(() => true);
    const onText = vi.fn(() => true);
    const onData = vi.fn();
    const controller = new GhosttyInputController({
      model: inputModel(),
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      isMac: true,
      onCopy: () => false,
      onKeyDown,
      onText,
      onData,
    });
    const interrupt = keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true });
    input.dispatchEvent(interrupt);
    expect(onKeyDown).toHaveBeenCalledWith(interrupt);
    expect(interrupt.defaultPrevented).toBe(true);
    onKeyDown.mockReturnValue(false);
    input.dispatchEvent(keyboardEvent({ key: "x", code: "KeyX" }));
    expect(onText).toHaveBeenCalledWith("x");
    input.dispatchEvent(
      Object.assign(new Event("compositionend"), { data: "あ" }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput", { cancelable: true }), {
        inputType: "insertText",
        data: "あ",
        isComposing: false,
      }),
    );
    expect(onText.mock.calls).toEqual([["x"], ["あ"]]);
    expect(onData).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("delivers Ctrl+C to the terminal and leaves unencoded shortcuts unconsumed", () => {
    const input = new FakeTextArea();
    const onData = vi.fn();
    const encodeKey = vi.fn(() => new Uint8Array([3]));
    const controller = new GhosttyInputController({
      model: { ...inputModel(), encodeKey },
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      isMac: true,
      onCopy: () => true,
      onData,
    });
    const interrupt = keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true });
    input.dispatchEvent(interrupt);
    expect(interrupt.defaultPrevented).toBe(true);
    expect(onData).toHaveBeenCalledWith(new Uint8Array([3]));
    encodeKey.mockReturnValue(new Uint8Array(0));
    const shortcut = keyboardEvent({ key: "p", code: "KeyP", metaKey: true });
    input.dispatchEvent(shortcut);
    expect(shortcut.defaultPrevented).toBe(false);
    const handled = keyboardEvent({ key: "c", code: "KeyC", ctrlKey: true });
    handled.preventDefault();
    input.dispatchEvent(handled);
    expect(onData).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("commits IME text once and leaves dead-key composition to the webview", () => {
    const input = new FakeTextArea();
    const onData = vi.fn();
    const model = inputModel();
    const encodeKey = vi.fn(() => new Uint8Array(0));
    const controller = new GhosttyInputController({
      model: { ...model, encodeKey },
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: false,
    });
    input.dispatchEvent(keyboardEvent({ key: "Dead", code: "Quote" }));
    expect(encodeKey).not.toHaveBeenCalled();
    input.dispatchEvent(new Event("compositionstart"));
    input.dispatchEvent(
      keyboardEvent({ key: "a", code: "KeyA", isComposing: true }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput"), {
        inputType: "insertCompositionText",
        data: "あ",
        isComposing: true,
      }),
    );
    expect(onData).not.toHaveBeenCalled();
    input.dispatchEvent(
      Object.assign(new Event("compositionend"), { data: "あ" }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput", { cancelable: true }), {
        inputType: "insertText",
        data: "あ",
        isComposing: false,
      }),
    );
    expect(onData).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe("あ");
    controller.dispose();
  });

  it("encodes AltGr characters and keeps a duplicate beforeinput from typing twice", () => {
    const input = new FakeTextArea();
    const onData = vi.fn();
    const controller = new GhosttyInputController({
      model: inputModel(),
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: false,
    });
    input.dispatchEvent(
      keyboardEvent({
        key: "@",
        code: "KeyQ",
        altKey: true,
        ctrlKey: true,
        getModifierState: (key) => key === "AltGraph",
      }),
    );
    input.dispatchEvent(
      Object.assign(new Event("beforeinput", { cancelable: true }), {
        inputType: "insertText",
        data: "@",
        isComposing: false,
      }),
    );
    expect(onData).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe("@");
    controller.dispose();
  });

  it("does not deliver a late clipboard result after the input owner is disposed", () => {
    const model = inputModel();
    const modes = vi.fn(model.modes);
    const onData = vi.fn();
    const input = new FakeTextArea();
    const controller = new GhosttyInputController({
      model: { ...model, modes },
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: new FakeElement() as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: false,
    });
    controller.dispose();
    controller.paste("late clipboard");
    input.dispatchEvent(keyboardEvent({ key: "x", code: "KeyX" }));
    expect(onData).not.toHaveBeenCalled();
    expect(modes).not.toHaveBeenCalled();
  });
  it("emits macOS Option-produced Unicode as text by default", () => {
    const input = new FakeTextArea();
    const pointerTarget = new FakeElement();
    const onData = vi.fn();
    const controller = new GhosttyInputController({
      model: inputModel(),
      input: input as unknown as HTMLTextAreaElement,
      pointerTarget: pointerTarget as unknown as HTMLElement,
      cellSize: () => ({ width: 10, height: 20 }),
      onData,
      onCopy: () => false,
      isMac: true,
    });

    input.dispatchEvent(
      keyboardEvent({
        key: "å",
        code: "KeyA",
        altKey: true,
      }),
    );

    expect(new TextDecoder().decode(onData.mock.calls[0][0])).toBe("å");
    controller.dispose();
  });

});

describe.each(["ghostty-vt.wasm", "ghostty-vt-scalar.wasm"])(
  "GhosttyInputController with the Ghostty core (%s)",
  (artifact) => {
    let core: TeraxGhostty;
    const decoder = new TextDecoder();

    beforeAll(async () => {
      const bytes = await readFile(
        new URL(
          `../../../../../packages/ghostty-core/adapted/${artifact}`,
          import.meta.url,
        ),
      );
      core = await TeraxGhostty.loadBytes(Uint8Array.from(bytes).buffer);
    });

    function setup(
      options: Partial<
        ConstructorParameters<typeof GhosttyInputController>[0]
      > & { devicePixelRatio?: number; kittyKeyboardFlags?: number } = {},
    ) {
      const replies: string[] = [];
      const model = new AdaptedGhosttyTerminalModel(core, {
        backend: "ghostty-webgpu",
        cols: 80,
        rows: 24,
        kittyKeyboardFlags: options.kittyKeyboardFlags,
        onReply: (bytes) => replies.push(decoder.decode(bytes)),
      });
      const scale = options.devicePixelRatio ?? 1;
      model.setPixelSize(800 * scale, 480 * scale);
      const input = new FakeTextArea();
      const pointerTarget = new FakeElement();
      const sent: string[] = [];
      const controller = new GhosttyInputController({
        model,
        input: input as unknown as HTMLTextAreaElement,
        pointerTarget: pointerTarget as unknown as HTMLElement,
        cellSize: () => ({ width: 10, height: 20 }),
        onData: (bytes) => sent.push(decoder.decode(bytes)),
        onCopy: () => false,
        isMac: false,
        ...options,
      });
      return {
        model,
        input,
        pointerTarget,
        sent,
        replies,
        write: (text: string) => model.write(new TextEncoder().encode(text)),
        dispose: () => {
          controller.dispose();
          model.dispose();
        },
        controller,
      };
    }

    it("reports presses and releases in the program's format", () => {
      const { pointerTarget, sent, write, dispose } = setup();
      write("\x1b[?1000h\x1b[?1006h");
      for (const [button, code] of [
        [0, 0],
        [1, 1],
        [2, 2],
      ] as const) {
        pointerTarget.dispatchEvent(
          mouseEvent("mousedown", { button, clientX: 25, clientY: 65 }),
        );
        pointerTarget.dispatchEvent(
          mouseEvent("mouseup", { button, clientX: 25, clientY: 65 }),
        );
        expect(sent.splice(0)).toEqual([
          `\x1b[<${code};3;4M`,
          `\x1b[<${code};3;4m`,
        ]);
      }
      // Shift leaves the mouse to selection.
      pointerTarget.dispatchEvent(
        mouseEvent("mousedown", { shiftKey: true, clientX: 25, clientY: 65 }),
      );
      expect(sent).toEqual([]);
      dispose();
    });

    it("reports buttonless motion once per cell where the grid is drawn", () => {
      let shift = 40;
      const { pointerTarget, sent, write, dispose } = setup({
        gridShiftY: () => shift,
      });
      write("\x1b[?1003h\x1b[?1006h");
      const move = (clientY: number) =>
        pointerTarget.dispatchEvent(
          mouseEvent("mousemove", { clientX: 15, clientY }),
        );
      // 25 px down with the grid moved up 40 px is 65 px into the grid: row 4.
      move(25);
      move(26);
      shift = 0;
      move(31);
      expect(sent).toEqual(["\x1b[<35;2;4M", "\x1b[<35;2;2M"]);
      dispose();
    });

    it("reports SGR pixels in the terminal's device pixels", () => {
      const { pointerTarget, sent, write, dispose } = setup({
        devicePixelRatio: 2,
      });
      write("\x1b[?1003h\x1b[?1016h");
      pointerTarget.dispatchEvent(
        mouseEvent("mousemove", { clientX: 15, clientY: 25 }),
      );
      expect(sent).toEqual(["\x1b[<35;30;50M"]);
      dispose();
    });

    it("turns wheel notches and trackpad distance into wheel buttons", () => {
      const { pointerTarget, sent, write, dispose } = setup({
        scrollMultiplier: () => 3,
      });
      write("\x1b[?1000h\x1b[?1006h");
      pointerTarget.dispatchEvent(
        wheelEvent({ deltaMode: 1, deltaY: 1, clientX: 5, clientY: 5 }),
      );
      expect(sent.splice(0)).toEqual(Array(3).fill("\x1b[<65;1;1M"));
      pointerTarget.dispatchEvent(
        wheelEvent({ deltaMode: 1, deltaX: -1, clientX: 5, clientY: 5 }),
      );
      expect(sent.splice(0)).toEqual(Array(3).fill("\x1b[<66;1;1M"));
      // 20 px is one cell: 8 px scrolls nothing yet, 12 more complete a row.
      pointerTarget.dispatchEvent(wheelEvent({ deltaY: -8 }));
      expect(sent).toEqual([]);
      pointerTarget.dispatchEvent(wheelEvent({ deltaY: -12 }));
      expect(sent).toEqual(["\x1b[<64;1;1M"]);
      dispose();
    });

    it("sends cursor keys for the wheel in full-screen programs that do not track it", () => {
      const { pointerTarget, sent, write, dispose } = setup();
      write("\x1b[?1049h\x1b[?1h");
      pointerTarget.dispatchEvent(wheelEvent({ deltaMode: 1, deltaY: 1 }));
      expect(sent).toEqual(Array(3).fill("\x1bOB"));
      dispose();
    });

    it("scrolls history with the wheel when nothing tracks it", () => {
      const { model, pointerTarget, sent, write, dispose } = setup();
      write("line\r\n".repeat(60));
      const before = model.scrollPosition().offset;
      pointerTarget.dispatchEvent(wheelEvent({ deltaMode: 1, deltaY: -1 }));
      // The offset counts lines scrolled up from the bottom.
      expect(model.scrollPosition().offset).toBe(before + 3);
      expect(sent).toEqual([]);
      dispose();
    });

    it("types Alt with the configured macOS Option key", () => {
      let setting: "off" | "left" | "right" | "both" = "left";
      const { input, sent, dispose } = setup({
        isMac: true,
        optionAsAlt: () => setting,
      });
      const option = (code: "AltLeft" | "AltRight", type: string) =>
        input.dispatchEvent(
          keyboardEvent({ key: "Alt", code, altKey: type === "keydown" }, type),
        );
      const type = (shiftKey = false) =>
        input.dispatchEvent(
          keyboardEvent({ key: "ƒ", code: "KeyF", altKey: true, shiftKey }),
        );
      option("AltLeft", "keydown");
      type();
      type(true);
      expect(sent.splice(0)).toEqual(["\x1bf", "\x1bF"]);
      setting = "right";
      type();
      expect(sent.splice(0)).toEqual(["ƒ"]);
      option("AltLeft", "keyup");
      option("AltRight", "keydown");
      type();
      expect(sent.splice(0)).toEqual(["\x1bf"]);
      setting = "off";
      type();
      expect(sent.splice(0)).toEqual(["ƒ"]);
      dispose();
    });

    // crynta/terax-ai#1381: Neovim pushes flags 3, and Shift+; must type ":".
    it.each([
      [false, 1],
      [false, 3],
      [true, 1],
      [true, 3],
    ])(
      "types Shift text as text in Kitty modes below report-all (macOS %s, flags %i)",
      (isMac, flags) => {
        const { input, sent, write, dispose } = setup({ isMac });
        write(`\x1b[>${flags}u`);
        const typed = [
          { key: ":", code: "Semicolon" },
          { key: "!", code: "Digit1" },
          { key: "A", code: "KeyA" },
          { key: '"', code: "Quote" },
          // Another layout's shifted character (German Shift+7).
          { key: "/", code: "Digit7" },
        ].map((values) => {
          input.dispatchEvent(keyboardEvent({ ...values, shiftKey: true }));
          return sent.splice(0).join("");
        });
        expect(typed).toEqual([":", "!", "A", '"', "/"]);
        // Shift stays a modifier where it types nothing different, and
        // with Control.
        input.dispatchEvent(
          keyboardEvent({ key: " ", code: "Space", shiftKey: true }),
        );
        input.dispatchEvent(
          keyboardEvent({
            key: "A",
            code: "KeyA",
            shiftKey: true,
            ctrlKey: true,
          }),
        );
        expect(sent).toEqual(["\x1b[32;2u", "\x1b[97;6u"]);
        dispose();
      },
    );

    // crynta/terax-ai#1288: Kitty programs read Shift+Enter, not Alt+Enter.
    it("encodes Shift+Enter in the program's keyboard mode", () => {
      const { input, sent, write, dispose } = setup();
      const shiftEnter = () =>
        input.dispatchEvent(
          keyboardEvent({ key: "Enter", code: "Enter", shiftKey: true }),
        );
      shiftEnter();
      write("\x1b[>1u");
      shiftEnter();
      write("\x1b[<u\x1b[>4;2m");
      shiftEnter();
      expect(sent).toEqual(["\x1b\r", "\x1b[13;2u", "\x1b[27;2;13~"]);
      dispose();
    });

    // crynta/terax-ai#1378: pi asks for flags 7, and Windows' inbox ConPTY
    // drops every input CSI with a ':' sub-parameter (its arrows, here).
    it("withholds Kitty flags the platform cannot carry", () => {
      const { input, sent, replies, write, dispose } = setup({
        kittyKeyboardFlags: supportedKittyKeyboardFlags("windows"),
      });
      write("\x1b[>7u\x1b[?u");
      expect(replies.splice(0)).toEqual(["\x1b[?1u"]);
      const keys = [
        { key: "ArrowUp", code: "ArrowUp" },
        { key: "Home", code: "Home" },
        { key: "A", code: "KeyA", shiftKey: true },
        { key: "Escape", code: "Escape" },
      ];
      for (const values of keys) {
        input.dispatchEvent(keyboardEvent(values));
        input.dispatchEvent(keyboardEvent(values, "keyup"));
      }
      expect(sent).toEqual(["\x1b[A", "\x1b[H", "A", "\x1b[27u"]);
      // Sets and ors are limited too; clearing needs no limit.
      write("\x1b[=31u\x1b[?u\x1b[=6;2u\x1b[?u\x1b[=8;3u\x1b[?u");
      expect(replies.join("")).toBe("\x1b[?25u\x1b[?25u\x1b[?17u");
      dispose();
    });

    it("reports Num Lock only with keypad keys", () => {
      const { input, sent, write, dispose } = setup();
      const numLock = (key: string) => key === "NumLock";
      write("\x1b[>9u");
      input.dispatchEvent(
        keyboardEvent({
          key: "ArrowUp",
          code: "ArrowUp",
          getModifierState: numLock,
        }),
      );
      input.dispatchEvent(
        keyboardEvent({ key: "1", code: "Numpad1", getModifierState: numLock }),
      );
      expect(sent).toEqual(["\x1b[A", "\x1b[57400;129u"]);
      dispose();
    });

    it("reports the unshifted key with Shift under report-all", () => {
      const { input, sent, write, dispose } = setup();
      write("\x1b[>15u");
      input.dispatchEvent(
        keyboardEvent({ key: ":", code: "Semicolon", shiftKey: true }),
      );
      input.dispatchEvent(
        keyboardEvent({ key: "A", code: "KeyA", shiftKey: true }),
      );
      expect(sent).toEqual(["\x1b[59:58;2u", "\x1b[97:65;2u"]);
      dispose();
    });

    it("encodes Option-as-Alt with Shift from the unshifted key", () => {
      const { input, sent, write, dispose } = setup({
        isMac: true,
        optionAsAlt: () => "both",
      });
      const type = () =>
        input.dispatchEvent(
          keyboardEvent({
            key: "Ú",
            code: "Semicolon",
            altKey: true,
            shiftKey: true,
          }),
        );
      type();
      write("\x1b[>1u");
      type();
      expect(sent).toEqual(["\x1b:", "\x1b[59;4u"]);
      dispose();
    });

    it("asks before an unbracketed paste with line breaks", async () => {
      const answers = [false, true];
      const confirmPaste = vi.fn(async () => answers.shift() ?? false);
      const { controller, sent, write, dispose } = setup({ confirmPaste });
      controller.paste("echo safe");
      expect(sent.splice(0)).toEqual(["echo safe"]);
      controller.paste("rm -rf ~\n");
      await Promise.resolve();
      expect(sent).toEqual([]);
      controller.paste("echo ok\n");
      await vi.waitFor(() => expect(sent).toEqual(["echo ok\r"]));
      write("\x1b[?2004h");
      controller.paste("bracketed\n");
      expect(confirmPaste).toHaveBeenCalledTimes(2);
      expect(sent[1]).toBe("\x1b[200~bracketed\r\x1b[201~");
      dispose();
    });

    it("tells a program with Kitty paste events of clipboard pastes, not their text", async () => {
      let image = true;
      const clipboardHasImage = vi.fn(async () => image);
      const { controller, model, sent, replies, write, dispose } = setup({
        clipboardHasImage,
      });
      /** The MIME types the next paste event lists. */
      const listed = async () => {
        await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0));
        const event = replies.splice(0).join("");
        expect(event).toMatch(
          /^\x1b\]5522;type=read:status=OK(:loc=primary)?:pw=[A-Za-z0-9+/]+=*\x1b\\/,
        );
        const listing = /status=DATA:mime=Lg==(?::loc=primary)?:pw=[^;]+;([^\x1b]*)/.exec(event)?.[1];
        return listing === undefined ? null : atob(listing);
      };
      model.setClipboardPolicy({ readsToHost: true, writesAllowed: true });
      controller.pasteFromClipboard("one");
      expect(sent.splice(0)).toEqual(["one"]);
      // The clipboard is looked at only for a program taking paste events.
      expect(clipboardHasImage).not.toHaveBeenCalled();

      write("\x1b[?5522h");
      controller.pasteFromClipboard("two", true);
      // Text that did not come from a clipboard is still typed.
      controller.paste("dropped");
      expect(sent.splice(0)).toEqual(["dropped"]);
      // The primary selection holds text only.
      expect(await listed()).toBe("text/plain\n");
      // A clipboard image is offered as PNG, alone when there is no text.
      controller.pasteFromClipboard("");
      expect(await listed()).toBe("image/png\n");
      controller.pasteFromClipboard("four");
      expect(await listed()).toBe("text/plain image/png\n");
      expect(sent).toEqual([]);
      // An empty clipboard pastes nothing.
      image = false;
      controller.pasteFromClipboard("");
      await vi.waitFor(() => expect(clipboardHasImage).toHaveBeenCalledTimes(3));
      await Promise.resolve();
      expect(replies).toEqual([]);
      expect(sent).toEqual([]);

      // Without the host serving reads the program could not fetch it.
      model.setClipboardPolicy({ readsToHost: false, writesAllowed: true });
      controller.pasteFromClipboard("three");
      expect(sent.splice(0)).toEqual(["three"]);
      expect(replies).toEqual([]);
      dispose();
    });

    it("finishes selections and middle-click pastes only when the program does not track the mouse", () => {
      const onSelectionFinished = vi.fn();
      const onMiddleClick = vi.fn(() => true);
      const { pointerTarget, write, dispose } = setup({
        onSelectionFinished,
        onMiddleClick,
      });
      pointerTarget.dispatchEvent(mouseEvent("pointerup", { button: 0 }));
      pointerTarget.dispatchEvent(mouseEvent("mousedown", { button: 1 }));
      expect(onSelectionFinished).toHaveBeenCalledOnce();
      expect(onMiddleClick).toHaveBeenCalledOnce();
      write("\x1b[?1000h");
      pointerTarget.dispatchEvent(mouseEvent("pointerup", { button: 0 }));
      pointerTarget.dispatchEvent(mouseEvent("mousedown", { button: 1 }));
      expect(onSelectionFinished).toHaveBeenCalledOnce();
      expect(onMiddleClick).toHaveBeenCalledOnce();
      dispose();
    });
  },
);

function inputModel(
  mode: (value: number) => boolean = () => false,
): GhosttyTerminalModelApi {
  return {
    cols: 80,
    rows: 24,
    modes: () => ({
      alternateScreen: false,
      bracketedPaste: false,
      focusReporting: false,
      mouseTracking: true,
      synchronizedOutput: false,
    }),
    mode,
    scrollToBottom: () => false,
    scrollPosition: () => ({ offset: 0, history: 0 }),
    scrollBy: () => false,
    encodeKey: () => new Uint8Array(0),
  } as unknown as GhosttyTerminalModelApi;
}

function keyboardEvent(
  values: Partial<KeyboardEvent>,
  type = "keydown",
): KeyboardEvent {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    altKey: false,
    code: "",
    ctrlKey: false,
    getModifierState: () => false,
    isComposing: false,
    key: "",
    keyCode: 0,
    metaKey: false,
    repeat: false,
    shiftKey: false,
    ...values,
  }) as KeyboardEvent;
}

function wheelEvent(values: Partial<WheelEvent>): WheelEvent {
  return Object.assign(mouseEvent("wheel", {}), {
    deltaMode: 0,
    deltaX: 0,
    deltaY: 0,
    deltaZ: 0,
    ...values,
  }) as WheelEvent;
}

function mouseEvent(type: string, values: Partial<MouseEvent>): MouseEvent {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    altKey: false,
    button: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...values,
  }) as MouseEvent;
}
