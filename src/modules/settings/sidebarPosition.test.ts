import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, parseSidebarPosition } from "./store";

describe("parseSidebarPosition", () => {
  it("keeps a stored side", () => {
    expect(parseSidebarPosition("left")).toBe("left");
    expect(parseSidebarPosition("right")).toBe("right");
  });

  it("docks left, as before the setting existed, for anything else", () => {
    expect(parseSidebarPosition(undefined)).toBe("left");
    expect(parseSidebarPosition("top")).toBe("left");
    expect(parseSidebarPosition(1)).toBe("left");
    expect(DEFAULT_PREFERENCES.sidebarPosition).toBe("left");
  });
});
