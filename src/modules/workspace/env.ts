import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { setLastWslDistro } from "@/modules/settings/store";

export type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string };

export type WslDistro = {
  name: string;
  default: boolean;
  running: boolean;
};

type State = {
  env: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  setEnv: (env: WorkspaceEnv) => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  setEnv: (env) => {
    set({ env });
    if (env.kind === "wsl") void setLastWslDistro(env.distro);
  },
  refreshDistros: async () => {
    set({ loading: true, error: null });
    try {
      const distros = await invoke<WslDistro[]>("wsl_list_distros");
      set({ distros, loading: false });
      return distros;
    } catch (e) {
      set({ distros: [], loading: false, error: String(e) });
      return [];
    }
  },
}));

export function currentWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().env;
}

// A Windows drive (`C:\`, `C:/`) or UNC (`\\server\share`, `\\?\C:\`) path.
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * The environment a file at `path` is read and written in. A Windows path
 * names a host file whatever environment the window works in, since a path
 * inside a WSL distro starts with `/`: the app's own config folder, for one,
 * stays on the host in a WSL window. The backend would otherwise look for it
 * inside the distro.
 */
export function workspaceEnvForPath(
  path: string,
  env: WorkspaceEnv = currentWorkspaceEnv(),
): WorkspaceEnv {
  return env.kind === "wsl" && WINDOWS_PATH.test(path) ? LOCAL_WORKSPACE : env;
}

export function workspaceScopeKey(env: WorkspaceEnv): string {
  return env.kind === "wsl" ? `wsl:${env.distro}` : "local";
}

export function parseWorkspaceScopeKey(key: string): WorkspaceEnv {
  return key.startsWith("wsl:")
    ? { kind: "wsl", distro: key.slice("wsl:".length) }
    : LOCAL_WORKSPACE;
}

export function currentWorkspaceScopeKey(): string {
  return workspaceScopeKey(currentWorkspaceEnv());
}

export async function getWslHome(distro: string): Promise<string> {
  return invoke<string>("wsl_home", { distro });
}
