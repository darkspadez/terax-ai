import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  currentWorkspaceEnv,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
  workspaceScopeKey,
} from "./env";

/**
 * Asset protocol URL of a workspace file. The protocol opens host paths, so
 * a WSL path is mapped to its share or drive path by the backend first;
 * local paths need no IPC.
 */
export async function workspaceAssetUrl(
  path: string,
  workspace: WorkspaceEnv = currentWorkspaceEnv(),
): Promise<string> {
  if (workspace.kind !== "wsl") return convertFileSrc(path);
  const host = await invoke<string>("fs_host_path", { path, workspace });
  return convertFileSrc(host);
}

/** `workspaceAssetUrl` for render: null until a WSL path is mapped. */
export function useWorkspaceAssetUrl(path: string | null): string | null {
  const workspace = useWorkspaceEnvStore((s) => s.env);
  const key = path === null ? null : `${workspaceScopeKey(workspace)}\0${path}`;
  const [mapped, setMapped] = useState<{ key: string; url: string } | null>(
    null,
  );

  useEffect(() => {
    if (path === null || key === null || workspace.kind !== "wsl") return;
    let cancelled = false;
    workspaceAssetUrl(path, workspace).then(
      (url) => {
        if (!cancelled) setMapped({ key, url });
      },
      (e) => console.warn("[workspace] no host path for", path, e),
    );
    return () => {
      cancelled = true;
    };
  }, [path, key, workspace]);

  if (path === null) return null;
  if (workspace.kind !== "wsl") return convertFileSrc(path);
  return mapped?.key === key ? mapped.url : null;
}
