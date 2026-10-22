import type { GitLogRef } from "@/modules/ai/lib/native";
import { describe, expect, it } from "vitest";
import { refsMatch, splitRefs } from "./refs";

const ref = (name: string, kind: GitLogRef["kind"] = "branch"): GitLogRef => ({
  kind,
  name,
  head: false,
});

describe("splitRefs", () => {
  it("shows every ref that fits", () => {
    const refs = [ref("main"), ref("v1.0", "tag")];
    expect(splitRefs(refs, 2)).toEqual({ shown: refs, hidden: [] });
  });

  it("shows a single extra ref instead of a count of one", () => {
    const refs = [ref("a"), ref("b"), ref("c")];
    expect(splitRefs(refs, 2)).toEqual({ shown: refs, hidden: [] });
  });

  it("puts the rest behind a count, keeping the order", () => {
    const refs = [ref("a"), ref("b"), ref("c"), ref("d")];
    expect(splitRefs(refs, 2)).toEqual({
      shown: [ref("a"), ref("b")],
      hidden: [ref("c"), ref("d")],
    });
  });
});

describe("refsMatch", () => {
  it("matches a lowercased query against ref names", () => {
    const refs = [ref("Release/2.0", "tag"), ref("origin/main", "remote")];
    expect(refsMatch(refs, "release")).toBe(true);
    expect(refsMatch(refs, "main")).toBe(true);
    expect(refsMatch(refs, "feature")).toBe(false);
  });
});
