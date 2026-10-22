import { findLeafCwd, leafIds } from "@/modules/terminal/lib/panes";
import type { Tab, TerminalTab } from "./useTabs";

export type PaneLabel = { leafId: number; name: string; active: boolean };

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}

/**
 * One name per pane of a terminal tab, in tree order: the title its program
 * set, else the last segment of its cwd, else the tab's title.
 */
export function paneLabels(
  tab: TerminalTab,
  programTitle: (leafId: number) => string | null = () => null,
): PaneLabel[] {
  return leafIds(tab.paneTree).map((leafId) => {
    const active = leafId === tab.activeLeafId;
    const cwd =
      findLeafCwd(tab.paneTree, leafId) ?? (active ? tab.cwd : undefined);
    const name = programTitle(leafId) || (cwd ? lastSegment(cwd) : tab.title);
    return { leafId, name, active };
  });
}

/**
 * The label shown on a tab. Non-terminal tabs use their stored title; terminal
 * tabs prefer a user-set custom name, then fall back to the last segment of the
 * cwd. Keeping this pure makes the "custom name survives a cd" invariant
 * testable without rendering the bar.
 */
export function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "preview") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.customTitle) return t.customTitle;
  if (!t.cwd) return t.title;
  return lastSegment(t.cwd);
}
