import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { DEFAULT_SPACE_ID, type Tab } from "./useTabs";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

export type SpaceCwdInput = {
  /** The window's active tab; ignored while it is not in the space. */
  activeTab: Tab | undefined;
  /** The space's tabs. */
  tabs: readonly Tab[];
  /** The cwd of the terminal last active in the space this session. */
  lastTerminalCwd: string | undefined;
  spaceRoot: string | null;
  home: string | null;
};

function activeTerminalCwd({ activeTab, tabs }: SpaceCwdInput) {
  return activeTab?.kind === "terminal" &&
    tabs.some((t) => t.id === activeTab.id)
    ? activeTab.cwd
    : undefined;
}

/**
 * The explorer and Source Control root for the active space: its active
 * terminal's cwd, else the terminal last active there, else any of its
 * terminals, else its root. Never another space's directory.
 */
export function spaceExplorerRoot(input: SpaceCwdInput): string | null {
  const anyTerminal = input.tabs.find((t) => t.kind === "terminal" && t.cwd);
  return (
    activeTerminalCwd(input) ??
    input.lastTerminalCwd ??
    (anyTerminal?.kind === "terminal" ? anyTerminal.cwd : undefined) ??
    input.spaceRoot ??
    input.home
  );
}

/**
 * Where a new terminal in the space starts: its active terminal's cwd, else
 * the terminal last active there (not an editor file's folder), else its
 * root.
 */
export function spaceNewTabCwd(input: SpaceCwdInput): string | undefined {
  return (
    activeTerminalCwd(input) ??
    input.lastTerminalCwd ??
    input.spaceRoot ??
    input.home ??
    undefined
  );
}

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
): Result {
  const spaceId = useSpaces((s) => s.activeId) ?? DEFAULT_SPACE_ID;
  const spaceRoot = useSpaces(
    (s) => s.spaces.find((space) => space.id === spaceId)?.root ?? null,
  );
  const spaceTabs = useMemo(
    () => tabs.filter((t) => t.spaceId === spaceId),
    [tabs, spaceId],
  );
  // Per space; read while rendering, written after, so a cd costs no render.
  const lastTerminalCwd = useRef(new Map<string, string>());

  useEffect(() => {
    if (
      activeTab?.kind === "terminal" &&
      activeTab.cwd &&
      activeTab.spaceId === spaceId
    ) {
      lastTerminalCwd.current.set(spaceId, activeTab.cwd);
    }
  }, [activeTab, spaceId]);

  const input = useCallback(
    (): SpaceCwdInput => ({
      activeTab,
      tabs: spaceTabs,
      lastTerminalCwd: lastTerminalCwd.current.get(spaceId),
      spaceRoot,
      home,
    }),
    [activeTab, spaceTabs, spaceId, spaceRoot, home],
  );

  const explorerRoot = useMemo(() => spaceExplorerRoot(input()), [input]);
  const inheritedCwdForNewTab = useCallback(
    () => spaceNewTabCwd(input()),
    [input],
  );

  return { explorerRoot, inheritedCwdForNewTab };
}
