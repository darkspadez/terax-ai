import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useAllFolders } from "./allFolders";
import {
  currentWorkspaceEnv,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "./env";

/**
 * The backend's scheme for previews while the app may access all folders:
 * the asset protocol serves only the authorized folders and its grants
 * cannot be taken back, while this one asks the setting on every request
 * (and still serves no dot folders).
 */
const ALL_FOLDERS_SCHEME = "oarlock-asset";

/** A host path as a URL the webview loads it from. */
function assetSrc(hostPath: string, allFolders: boolean): string {
  return allFolders
    ? convertFileSrc(hostPath, ALL_FOLDERS_SCHEME)
    : convertFileSrc(hostPath);
}

/**
 * Asset protocol URL of a workspace file. The protocol opens host paths, so
 * a WSL path is mapped to its share or drive path by the backend first;
 * local paths need no IPC.
 */
export async function workspaceAssetUrl(
  path: string,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
  allFolders = false,
): Promise<string> {
  if (workspace.kind !== "wsl") return assetSrc(path, allFolders);
  const host = await invoke<string>("fs_host_path", { path, workspace });
  return assetSrc(host, allFolders);
}

/**
 * `workspaceAssetUrl` for render: null until a WSL path is mapped. Follows
 * "Allow the app to access all folders", so turning it off reloads previews
 * through the asset protocol at once.
 */
export function useWorkspaceAssetUrl(path: string | null): string | null {
  const workspace = useWorkspaceEnvStore((s) => s.env);
  const allFolders = useAllFolders((s) => s.app);
  const key =
    path === null
      ? null
      : `${workspaceScopeKey(workspace)}\0${allFolders}\0${path}`;
  const [mapped, setMapped] = useState<{ key: string; url: string } | null>(
    null,
  );

  useEffect(() => {
    if (path === null || key === null || workspace.kind !== "wsl") return;
    let cancelled = false;
    workspaceAssetUrl(path, workspace, allFolders).then(
      (url) => {
        if (!cancelled) setMapped({ key, url });
      },
      (e) => console.warn("[workspace] no host path for", path, e),
    );
    return () => {
      cancelled = true;
    };
  }, [path, key, workspace, allFolders]);

  if (path === null) return null;
  if (workspace.kind !== "wsl") return assetSrc(path, allFolders);
  return mapped?.key === key ? mapped.url : null;
}
