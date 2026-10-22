import { describe, expect, it } from "vitest";
import { aiToggleAction } from "./aiToggle";

describe("aiToggleAction", () => {
  it("closes an open panel, with or without a provider", () => {
    expect(aiToggleAction(true, true)).toBe("close");
    expect(aiToggleAction(true, false)).toBe("close");
  });

  it("opens a closed panel, or asks for a provider first", () => {
    expect(aiToggleAction(false, true)).toBe("open");
    expect(aiToggleAction(false, false)).toBe("connect");
  });
});
