import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readClipboardImage,
  readTerminalClipboard,
  writeClipboardImage,
  writeTerminalClipboard,
  writeTerminalClipboardContent,
} from "./terminalClipboard";

const native = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => native);
const ipc = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke: ipc.invoke,
}));
const web = { readText: vi.fn(), writeText: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("isTauri", true);
  vi.stubGlobal("navigator", { clipboard: web });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("terminal clipboard", () => {
  it.each(["Macintosh", "Windows NT", "X11; Linux"])(
    "uses native copy and paste in the %s application without WebKit prompts",
    async (userAgent) => {
      vi.stubGlobal("navigator", { userAgent, clipboard: web });
      native.readText.mockResolvedValue("external copy");
      await expect(readTerminalClipboard()).resolves.toBe("external copy");
      await writeTerminalClipboard("terminal selection");
      expect(native.writeText).toHaveBeenCalledWith("terminal selection");
      expect(web.readText).not.toHaveBeenCalled();
      expect(web.writeText).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to permission-gated web reads after an IPC failure", async () => {
    native.readText.mockRejectedValue(new Error("clipboard busy"));
    await expect(readTerminalClipboard()).resolves.toBe("");
    expect(web.readText).not.toHaveBeenCalled();
    native.readText.mockResolvedValue("retry");
    await expect(readTerminalClipboard()).resolves.toBe("retry");
  });

  it("reports failed copies instead of signaling success", async () => {
    native.writeText.mockRejectedValue(new Error("clipboard busy"));
    await expect(writeTerminalClipboard("text")).rejects.toThrow(
      "clipboard busy",
    );
    expect(web.writeText).not.toHaveBeenCalled();
  });

  it("uses browser clipboard APIs in a browser preview", async () => {
    vi.stubGlobal("isTauri", false);
    web.readText.mockResolvedValue("web");
    await expect(readTerminalClipboard()).resolves.toBe("web");
    await writeTerminalClipboard("preview");
    expect(web.writeText).toHaveBeenCalledWith("preview");
    expect(native.readText).not.toHaveBeenCalled();
    expect(native.writeText).not.toHaveBeenCalled();
  });
});

describe("clipboard images", () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);

  it("reads the image once for reads close together, none as null", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A write first drops any read an earlier test left.
    await writeTerminalClipboard("");
    ipc.invoke.mockResolvedValue(png.slice().buffer);
    await expect(readClipboardImage()).resolves.toEqual(png);
    await expect(readClipboardImage()).resolves.toEqual(png);
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    expect(ipc.invoke).toHaveBeenCalledWith("clipboard_image_read");

    // A second later the clipboard is read again: it may have changed.
    vi.advanceTimersByTime(1000);
    ipc.invoke.mockResolvedValue(new ArrayBuffer(0));
    await expect(readClipboardImage()).resolves.toBeNull();
    // So it is after this app writes it.
    ipc.invoke.mockResolvedValue(png.slice().buffer);
    await writeTerminalClipboard("text");
    await expect(readClipboardImage()).resolves.toEqual(png);
    ipc.invoke.mockRejectedValue(new Error("no clipboard"));
    vi.advanceTimersByTime(1000);
    await expect(readClipboardImage()).resolves.toBeNull();
  });

  it("writes a PNG as it is, and a program's image with its text to fall back on", async () => {
    ipc.invoke.mockResolvedValue(undefined);
    await writeClipboardImage(png, "image/PNG");
    expect(ipc.invoke).toHaveBeenCalledWith("clipboard_image_write", png);

    // The webview cannot decode this one (no createImageBitmap here).
    await writeTerminalClipboardContent({
      mime: "image/webp",
      data: png,
      text: "alt",
    });
    expect(native.writeText).toHaveBeenCalledWith("alt");
    await expect(
      writeTerminalClipboardContent({ mime: "image/webp", data: png }),
    ).rejects.toThrow();
    await writeTerminalClipboardContent("plain");
    expect(native.writeText).toHaveBeenLastCalledWith("plain");
  });

  it("converts other image types to PNG through a canvas", async () => {
    const converted = Uint8Array.of(1, 2, 3);
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => {
        expect(blob.type).toBe("image/jpeg");
        return { width: 3, height: 2, close };
      }),
    );
    const drawImage = vi.fn();
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({ drawImage }),
        toBlob: (done: (blob: Blob) => void, type: string) =>
          done(new Blob([converted], { type })),
      }),
    });
    ipc.invoke.mockResolvedValue(undefined);
    await writeClipboardImage(png, "image/jpeg");
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(ipc.invoke).toHaveBeenCalledWith("clipboard_image_write", converted);
  });
});
