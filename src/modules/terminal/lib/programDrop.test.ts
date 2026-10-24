import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: false }));

import {
  droppedPathItems,
  fileUri,
  terminalDragPosition,
} from "./programDrop";

const decoder = new TextDecoder();

describe("program drops", () => {
  it("names dropped files by file URIs", () => {
    expect(fileUri("/repo/My File#1.ts", false)).toBe(
      "file:///repo/My%20File%231.ts",
    );
    // A backslash is part of a Unix file name.
    expect(fileUri("/tmp/a\\b", false)).toBe("file:///tmp/a%5Cb");
    expect(fileUri("C:\\Users\\me\\a b.txt", true)).toBe(
      "file:///C:/Users/me/a%20b.txt",
    );
    expect(fileUri("\\\\server\\share\\f.txt", true)).toBe(
      "file://server/share/f.txt",
    );
  });

  it("offers a drop as a URI list and as plain paths", () => {
    const [uris, plain] = droppedPathItems(["/a b", "/c"], false);
    expect(uris.mime).toBe("text/uri-list");
    expect(decoder.decode(uris.data)).toBe("file:///a%20b\r\nfile:///c\r\n");
    expect(plain.mime).toBe("text/plain");
    expect(decoder.decode(plain.data)).toBe("/a b\n/c");
  });

  it("places a drag in cells and terminal pixels", () => {
    // 8x16 CSS cells drawn with 16x32 device pixels each.
    expect(
      terminalDragPosition(20, 40, { width: 8, height: 16 }, { width: 16, height: 32 }),
    ).toEqual({ cellX: 2, cellY: 2, pixelX: 40, pixelY: 80, copy: true, move: false });
    // Without a terminal pixel size, CSS pixels; never a negative cell.
    expect(terminalDragPosition(-3, 5, { width: 8, height: 16 }, null)).toEqual({
      cellX: 0,
      cellY: 0,
      pixelX: -3,
      pixelY: 5,
      copy: true,
      move: false,
    });
    expect(terminalDragPosition(1, 1, { width: 0, height: 16 }, null)).toBeNull();
  });
});
