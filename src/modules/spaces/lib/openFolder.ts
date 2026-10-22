import { invoke } from "@tauri-apps/api/core";
import type { Tab } from "@/modules/tabs";
import { LOCAL_WORKSPACE } from "@/modules/workspace";
import { planOpenFolder } from "./activeSpace";
import type { SpaceMeta } from "./store";

export type OpenFolderDeps = {
  /** The folder the user picked, or null when they cancelled. */
  pick: () => Promise<string | null>;
  /** Authorizes the folder as a workspace; resolves to its canonical path. */
  authorize: (path: string) => Promise<string>;
  spaces: () => SpaceMeta[];
  tabs: () => Tab[];
  /** Adds a local space and returns its id. */
  createSpace: (space: { name: string; root: string }) => string;
  /** Adds a terminal tab to the space and returns its id. */
  newTerminal: (spaceId: string, cwd: string) => number;
  activate: (spaceId: string, tabId: number) => void;
  fail: (error: unknown) => void;
};

/**
 * Open Folder: the folder the user picks opens the way `terax <dir>` does at
 * launch (`planOpenFolder`), authorized before any shell starts in it.
 * Cancelling the picker does nothing.
 */
export async function openFolder(deps: OpenFolderDeps): Promise<void> {
  try {
    const picked = await deps.pick();
    if (picked === null) return;
    const folder = (await deps.authorize(picked)).replace(/\\/g, "/");
    const plan = planOpenFolder(deps.spaces(), deps.tabs(), folder);
    const spaceId =
      plan.space.kind === "existing"
        ? plan.space.id
        : deps.createSpace(plan.space);
    deps.activate(spaceId, plan.tabId ?? deps.newTerminal(spaceId, folder));
  } catch (error) {
    deps.fail(error);
  }
}

/** The OS folder picker, loaded on first use: one folder, null if cancelled. */
export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open({ title: "Open Folder", directory: true, multiple: false });
}

/** A picked folder is a host path, whatever the window's environment. */
export function authorizeLocalFolder(path: string): Promise<string> {
  return invoke<string>("workspace_authorize", {
    path,
    workspace: LOCAL_WORKSPACE,
  });
}
