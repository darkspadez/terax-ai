import { describe, expect, it, vi } from "vitest";

const answer = vi.hoisted(() => ({ next: null as ArrayBuffer | Error | null }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) => {
    if (command !== "clipboard_image_read") throw new Error(command);
    if (answer.next instanceof Error) throw answer.next;
    return answer.next;
  },
}));

import {
  clipboardImageFile,
  pastedImages,
  pasteKeepsText,
  pasteNeedsClipboardImage,
  readClipboardImageFile,
} from "./pastedImages";

const png = new File([new Uint8Array([1])], "image.png", { type: "image/png" });
const txt = new File(["x"], "notes.txt", { type: "text/plain" });

function clipboard(input: {
  files?: File[];
  items?: { kind: string; type: string; file: File | null }[];
  types?: string[];
}) {
  return {
    files: input.files ?? [],
    items: (input.items ?? []).map((i) => ({
      kind: i.kind,
      type: i.type,
      getAsFile: () => i.file,
    })),
    types: input.types ?? [],
  } as unknown as Pick<DataTransfer, "files" | "items" | "types">;
}

describe("pastedImages", () => {
  it("takes images from the pasted files", () => {
    expect(pastedImages(clipboard({ files: [png, txt] }))).toEqual([png]);
  });

  it("falls back to file items when files is empty", () => {
    expect(
      pastedImages(
        clipboard({
          items: [
            { kind: "string", type: "text/html", file: null },
            { kind: "file", type: "image/png", file: png },
          ],
        }),
      ),
    ).toEqual([png]);
  });

  it("finds nothing in a text paste", () => {
    expect(
      pastedImages(
        clipboard({
          items: [{ kind: "string", type: "text/plain", file: null }],
          types: ["text/plain"],
        }),
      ),
    ).toEqual([]);
  });
});

describe("pasteKeepsText", () => {
  it("lets text through alongside an attached image", () => {
    expect(pasteKeepsText(clipboard({ types: ["text/plain", "Files"] }))).toBe(
      true,
    );
    expect(pasteKeepsText(clipboard({ types: ["Files"] }))).toBe(false);
  });
});

// crynta/terax-ai#274: WebKitGTK lists a clipboard image as "Files" and hands
// over no file, so the app reads it.
describe("pasteNeedsClipboardImage", () => {
  it("reads the clipboard's image when the webview handed none", () => {
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["Files"] }), false),
    ).toBe(true);
    expect(pasteNeedsClipboardImage(clipboard({}), false)).toBe(true);
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["text/html"] }), false),
    ).toBe(true);
  });

  it("leaves text pastes, files and the primary selection alone", () => {
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["text/plain"] }), false),
    ).toBe(false);
    // A file copied in a file manager that is no image: never its icon.
    expect(
      pasteNeedsClipboardImage(
        clipboard({ files: [txt], types: ["Files"] }),
        false,
      ),
    ).toBe(false);
    expect(
      pasteNeedsClipboardImage(
        clipboard({
          items: [{ kind: "file", type: "text/plain", file: txt }],
          types: ["Files"],
        }),
        false,
      ),
    ).toBe(false);
    // A middle click pastes the primary selection, not the clipboard.
    expect(
      pasteNeedsClipboardImage(clipboard({ types: ["Files"] }), true),
    ).toBe(false);
  });
});

describe("clipboardImageFile", () => {
  it("is a PNG named like a pasted screenshot", () => {
    const file = clipboardImageFile(new Uint8Array([137, 80, 78, 71]), 42);
    expect(file.name).toBe("image.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
    expect(file.lastModified).toBe(42);
  });
});

describe("readClipboardImageFile", () => {
  it("attaches the image the app reads off the clipboard", async () => {
    answer.next = new Uint8Array([137, 80, 78, 71]).buffer;
    const file = await readClipboardImageFile();
    expect(file?.name).toBe("image.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBe(4);
  });

  it("finds nothing when the clipboard holds no image or cannot be read", async () => {
    answer.next = new ArrayBuffer(0);
    expect(await readClipboardImageFile()).toBeNull();
    answer.next = new Error("clipboard unavailable");
    expect(await readClipboardImageFile()).toBeNull();
  });
});
