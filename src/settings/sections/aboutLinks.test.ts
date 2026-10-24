import { describe, expect, it } from "vitest";
import { ISSUES_URL, REPO_SLUG, REPO_URL } from "./aboutLinks";

describe("About links", () => {
  it("point at Oarlock's repository, not upstream", () => {
    expect(REPO_SLUG).toBe("qopsc/oarlock");
    expect(REPO_URL).toBe("https://github.com/qopsc/oarlock");
    expect(ISSUES_URL).toBe("https://github.com/qopsc/oarlock/issues");
  });
});
