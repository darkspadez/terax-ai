import { describe, expect, it } from "vitest";
import { textWindow } from "./textWindow";

describe("textWindow", () => {
  it("returns the first 2000 lines by default", () => {
    const text = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
    const window = textWindow(text);
    expect(window.content.split("\n")).toHaveLength(2000);
    expect(window).toMatchObject({
      totalLines: 2500,
      startLine: 0,
      endLine: 2000,
      truncated: true,
    });
  });

  it("windows by offset and limit", () => {
    const window = textWindow("a\nb\nc\nd", 1, 2);
    expect(window).toEqual({
      content: "b\nc",
      totalLines: 4,
      startLine: 1,
      endLine: 3,
      truncated: true,
    });
    expect(textWindow("a\nb", 0, 5).truncated).toBe(false);
  });

  it("cuts at 25 KB", () => {
    const window = textWindow("x".repeat(30 * 1024));
    expect(window.content).toHaveLength(25 * 1024);
    expect(window.truncated).toBe(true);
  });
});
