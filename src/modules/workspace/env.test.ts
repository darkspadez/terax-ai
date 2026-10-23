import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

import { LOCAL_WORKSPACE, workspaceEnvForPath } from "./env";

const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;

describe("workspaceEnvForPath", () => {
  it("reads a Windows path on the host in a WSL window", () => {
    for (const path of [
      "C:\\Users\\me\\AppData\\Roaming\\sh.oarlock.app\\themes\\mine.oarlock-theme",
      "c:/Users/me/AppData/Roaming/sh.oarlock.app/themes",
      "D:\\",
      "\\\\fileserver\\profiles\\me\\AppData\\Roaming",
      "\\\\?\\C:\\Users\\me",
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.md",
    ]) {
      expect(workspaceEnvForPath(path, ubuntu)).toEqual(LOCAL_WORKSPACE);
    }
  });

  it("keeps a path inside the distro in the window's WSL environment", () => {
    for (const path of [
      "/home/me/project/README.md",
      "/mnt/c/Users/me/project",
      "/",
      "//double/slash",
      "relative/C:/name",
    ]) {
      expect(workspaceEnvForPath(path, ubuntu)).toBe(ubuntu);
    }
  });

  it("changes nothing in a local window", () => {
    expect(workspaceEnvForPath("C:\\Users\\me", LOCAL_WORKSPACE)).toBe(
      LOCAL_WORKSPACE,
    );
    expect(workspaceEnvForPath("/home/me", LOCAL_WORKSPACE)).toBe(
      LOCAL_WORKSPACE,
    );
  });
});
