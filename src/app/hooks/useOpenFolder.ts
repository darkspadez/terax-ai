import { getCurrentWindow } from "@tauri-apps/api/window";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSpaces } from "@/modules/spaces";
import {
  authorizeLocalFolder,
  openFolder,
  pickFolder,
} from "@/modules/spaces/lib/openFolder";
import type { Tab } from "@/modules/tabs";
import { LOCAL_WORKSPACE, useWorkspaceEnvStore } from "@/modules/workspace";

type Params = {
  tabsRef: RefObject<Tab[]>;
  newTabInSpace: (spaceId: string, cwd?: string) => number;
  setActiveId: (id: number) => void;
};

/**
 * Open Folder for this window (palette, explorer, Spaces menu, and the macOS
 * File menu through `terax:open-folder-requested`). One picker at a time.
 */
export function useOpenFolder({
  tabsRef,
  newTabInSpace,
  setActiveId,
}: Params): () => void {
  const picking = useRef(false);

  const open = useCallback(() => {
    if (picking.current) return;
    picking.current = true;
    void openFolder({
      pick: pickFolder,
      authorize: authorizeLocalFolder,
      spaces: () => useSpaces.getState().spaces,
      tabs: () => tabsRef.current,
      createSpace: ({ name, root }) =>
        useSpaces.getState().create({ name, root, env: LOCAL_WORKSPACE }).id,
      newTerminal: newTabInSpace,
      activate: (spaceId, tabId) => {
        // Before the tab mounts: its shell starts in the space's environment.
        useWorkspaceEnvStore.getState().setEnv(LOCAL_WORKSPACE);
        setActiveId(tabId);
        useSpaces.getState().setActive(spaceId);
      },
      fail: (error) =>
        toast.error("Could not open the folder", {
          description: String(error),
        }),
    }).finally(() => {
      picking.current = false;
    });
  }, [tabsRef, newTabInSpace, setActiveId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .listen("terax:open-folder-requested", open)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open]);

  return open;
}
