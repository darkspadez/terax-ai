import { useCallback, useEffect, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { native } from "@/modules/ai/lib/native";
import { useSpaces } from "@/modules/spaces";
import { planEnvSwitch } from "@/modules/spaces/lib/activeSpace";
import {
  getWslHome,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
} from "@/modules/workspace";

async function resolveEnvHome(env: WorkspaceEnv): Promise<string> {
  return env.kind === "wsl"
    ? getWslHome(env.distro)
    : (await homeDir()).replace(/\\/g, "/");
}

type Params = {
  setWorkspaceEnv: (env: WorkspaceEnv) => void;
  newTab: (cwd?: string) => number;
  setActiveSpaceForNewTabs: (id: string) => void;
};

/**
 * Owns the resolved home / launch cwd. switchWorkspace answers the status-bar
 * environment picker (Windows): it moves to a space with that environment, or
 * opens one at its home, so no shell or tab of any space is closed;
 * adoptWorkspaceEnv applies a space's env + home when it becomes active.
 */
export function useWorkspaceSwitcher({
  setWorkspaceEnv,
  newTab,
  setActiveSpaceForNewTabs,
}: Params) {
  const [home, setHome] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);

  useEffect(() => {
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        setHome(normalized);
        try {
          await native.workspaceAuthorize(normalized);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => setHome(null));
  }, []);

  useEffect(() => {
    native
      .workspaceCurrentDir()
      .then(setLaunchCwd)
      .catch(() => setLaunchCwd(null))
      .finally(() => setLaunchCwdResolved(true));
  }, []);

  const authorizeHome = useCallback(async (nextHome: string) => {
    setHome(nextHome);
    setLaunchCwd(nextHome);
    try {
      await native.workspaceAuthorize(nextHome);
    } catch {
      // Non-fatal — git panel will surface "not authorized" if needed.
    }
  }, []);

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv): Promise<void> => {
      const spaces = useSpaces.getState();
      const plan = planEnvSwitch(spaces.spaces, spaces.activeId, env);
      if (plan.kind === "stay") return;
      if (plan.kind === "activate") {
        spaces.setActive(plan.spaceId);
        return;
      }
      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch (e) {
        window.alert(String(e));
        return;
      }
      // Before the tab mounts: its shell starts in the window's environment.
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      const meta = useSpaces
        .getState()
        .create({ name: plan.name, root: nextHome, env });
      setActiveSpaceForNewTabs(meta.id);
      newTab(nextHome);
      useSpaces.getState().setActive(meta.id);
    },
    [setWorkspaceEnv, newTab, setActiveSpaceForNewTabs],
  );

  const adoptWorkspaceEnv = useCallback(
    async (env: WorkspaceEnv): Promise<string | null> => {
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch {
        return null;
      }
      await authorizeHome(nextHome);
      return nextHome;
    },
    [setWorkspaceEnv, authorizeHome],
  );

  return {
    home,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
  };
}
