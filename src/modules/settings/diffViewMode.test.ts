import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, parseDiffViewMode } from "./store";

describe("parseDiffViewMode", () => {
  it("keeps the stored layout", () => {
    expect(parseDiffViewMode("split")).toBe("split");
    expect(parseDiffViewMode("inline")).toBe("inline");
  });

  it("falls back to inline for anything else", () => {
    expect(parseDiffViewMode(undefined)).toBe("inline");
    expect(parseDiffViewMode("side-by-side")).toBe("inline");
    expect(DEFAULT_PREFERENCES.diffViewMode).toBe("inline");
  });
});
