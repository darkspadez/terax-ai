import { describe, expect, it } from "vitest";
import { bodyText, labelText } from "./displayText";

describe("labelText", () => {
  it("keeps one line, without controls or bidi overrides", () => {
    expect(labelText("ab\u202Ecd\nef\u0007")).toBe("abcd ef");
    expect(labelText("  name  ")).toBe("name");
    expect(labelText(42)).toBe("");
  });

  it("caps what it shows", () => {
    expect(labelText("abcdef", 3)).toBe("abc…");
    expect(labelText("abc", 3)).toBe("abc");
  });
});

describe("bodyText", () => {
  it("keeps lines and tabs but drops other controls", () => {
    expect(bodyText("a\r\nb\tc\u2066d\u0000")).toBe("a\nb\tcd");
  });
});
