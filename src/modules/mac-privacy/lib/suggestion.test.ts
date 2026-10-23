import { describe, expect, it } from "vitest";
import { shouldSuggestFullDiskAccess } from "./suggestion";

describe("shouldSuggestFullDiskAccess", () => {
  it("suggests it when Terax is known not to have it", () => {
    expect(shouldSuggestFullDiskAccess("denied")).toBe(true);
  });

  it("never suggests it to a Terax that has it, or may have it", () => {
    expect(shouldSuggestFullDiskAccess("allowed")).toBe(false);
    expect(shouldSuggestFullDiskAccess("unknown")).toBe(false);
  });
});
