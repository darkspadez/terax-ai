import { parentDir } from "@/modules/explorer/lib/watch";
import type { Tab } from "@/modules/tabs";

/**
 * Directories and files the fs watcher must report for the open file tabs:
 * editors reload from them and rendered Markdown previews refresh.
 */
export function fileWatchTargets(tabs: readonly Tab[]): {
  dirs: Set<string>;
  files: Set<string>;
} {
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind !== "editor" && tab.kind !== "markdown") continue;
    dirs.add(parentDir(tab.path));
    files.add(tab.path);
  }
  return { dirs, files };
}
