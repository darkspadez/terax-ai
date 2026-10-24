import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, parseEditorDefaultIndent } from "./store";

describe("parseEditorDefaultIndent", () => {
  it("keeps a stored choice and falls back to two spaces", () => {
    expect(parseEditorDefaultIndent("spaces4")).toBe("spaces4");
    expect(parseEditorDefaultIndent("tab")).toBe("tab");
    expect(parseEditorDefaultIndent(3)).toBe("spaces2");
    expect(DEFAULT_PREFERENCES.editorDefaultIndent).toBe("spaces2");
  });
});
