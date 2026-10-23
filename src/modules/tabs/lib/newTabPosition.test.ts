// crynta/terax-ai#683: new tabs can open right after the current one.
import { describe, expect, it } from "vitest";
import { parseNewTabPosition } from "@/modules/settings/store";
import { appendTab, newTabInserter } from "./newTabPosition";
import {
  planCommitHistoryOpen,
  planFileTabOpen,
  planGitDiffOpen,
  planMarkdownTabOpen,
  type Tab,
} from "./useTabs";

function preview(id: number, spaceId = "a"): Tab {
  return { id, kind: "preview", spaceId, title: `t${id}`, url: "" };
}

const strip = [preview(1), preview(2), preview(3, "b"), preview(4)];
const ids = (tabs: readonly Tab[]) => tabs.map((t) => t.id);

describe("newTabInserter", () => {
  it("appends at the end by default", () => {
    expect(ids(newTabInserter("end", 1)(strip, preview(9)))).toEqual([
      1, 2, 3, 4, 9,
    ]);
    expect(newTabInserter("end", 1)).toBe(appendTab);
  });

  it("inserts right after the active tab of the same space", () => {
    const after = newTabInserter("afterCurrent", 1);
    expect(ids(after(strip, preview(9)))).toEqual([1, 9, 2, 3, 4]);
    expect(ids(newTabInserter("afterCurrent", 4)(strip, preview(9)))).toEqual([
      1, 2, 3, 4, 9,
    ]);
  });

  it("appends a tab for another space, a missing active tab or the background", () => {
    expect(
      ids(newTabInserter("afterCurrent", 1)(strip, preview(9, "b"))),
    ).toEqual([1, 2, 3, 4, 9]);
    expect(ids(newTabInserter("afterCurrent", 42)(strip, preview(9)))).toEqual([
      1, 2, 3, 4, 9,
    ]);
    expect(newTabInserter("afterCurrent", 1, false)).toBe(appendTab);
  });

  it("never changes the list it is given", () => {
    const before = [...strip];
    newTabInserter("afterCurrent", 2)(strip, preview(9));
    expect(strip).toEqual(before);
  });

  it("reads an unknown stored value as the default", () => {
    expect(parseNewTabPosition("afterCurrent")).toBe("afterCurrent");
    expect(parseNewTabPosition("end")).toBe("end");
    expect(parseNewTabPosition("atLast")).toBe("end");
    expect(parseNewTabPosition(undefined)).toBe("end");
  });
});

describe("open planners place new tabs with the inserter", () => {
  const after = newTabInserter("afterCurrent", 1);
  let next = 100;
  const allocId = () => next++;

  it("places new editor, preview editor and markdown tabs", () => {
    expect(
      ids(planFileTabOpen(strip, "/x.ts", true, "a", allocId, after).tabs),
    ).toEqual([1, 100, 2, 3, 4]);
    expect(
      ids(planFileTabOpen(strip, "/y.ts", false, "a", allocId, after).tabs),
    ).toEqual([1, 101, 2, 3, 4]);
    expect(
      ids(planMarkdownTabOpen(strip, "/r.md", "a", allocId, after).tabs),
    ).toEqual([1, 102, 2, 3, 4]);
  });

  it("places new diff and history tabs", () => {
    const input = { repoRoot: "/r", path: "a.ts", mode: "+" as const };
    expect(
      ids(planGitDiffOpen(strip, input, "a", true, allocId, after).tabs),
    ).toEqual([1, 103, 2, 3, 4]);
    expect(
      ids(planGitDiffOpen(strip, input, "a", false, allocId, after).tabs),
    ).toEqual([1, 104, 2, 3, 4]);
    expect(
      ids(
        planCommitHistoryOpen(strip, { repoRoot: "/r" }, "a", allocId, after)
          .tabs,
      ),
    ).toEqual([1, 105, 2, 3, 4]);
  });

  it("keeps a reused preview slot where it is", () => {
    const tabs: Tab[] = [
      preview(1),
      {
        id: 2,
        kind: "editor",
        spaceId: "a",
        title: "old.ts",
        path: "/old.ts",
        dirty: false,
        preview: true,
      },
      preview(3),
    ];
    const plan = planFileTabOpen(tabs, "/new.ts", false, "a", allocId, after);
    expect(ids(plan.tabs)).toEqual([1, plan.tabId, 3]);
  });
});
