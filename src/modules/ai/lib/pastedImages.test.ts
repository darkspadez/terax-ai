import { describe, expect, it } from "vitest";
import { pastedImages, pasteKeepsText } from "./pastedImages";

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
