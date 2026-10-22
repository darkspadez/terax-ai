import { describe, expect, it } from "vitest";
import { ISSUES_URL, REPO_SLUG, REPO_URL } from "./aboutLinks";

describe("About links", () => {
  it("point at this fork, not upstream", () => {
    expect(REPO_SLUG).toBe("darkspadez/terax-ai");
    expect(REPO_URL).toBe("https://github.com/darkspadez/terax-ai");
    expect(ISSUES_URL).toBe("https://github.com/darkspadez/terax-ai/issues");
  });
});
