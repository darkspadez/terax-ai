import { describe, expect, it } from "vitest";
import { nextHistoryPage } from "./historyPaging";

describe("nextHistoryPage", () => {
  it("has nothing to continue before the first page", () => {
    expect(nextHistoryPage([])).toBeNull();
  });

  it("skips the loaded commits from the newest one, not the last one", () => {
    const loaded = [{ sha: "merge" }, { sha: "m3" }, { sha: "f3" }];
    expect(nextHistoryPage(loaded)).toEqual({ skip: 3, anchorSha: "merge" });
  });
});
