import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) =>
    `http://asset.localhost/${encodeURIComponent(path)}`,
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

const { workspaceAssetUrl } = await import("./assetUrl");

beforeEach(() => invoke.mockReset());

describe("workspaceAssetUrl", () => {
  it("converts a local path directly", async () => {
    expect(await workspaceAssetUrl("C:\\pics\\a.png", { kind: "local" })).toBe(
      `http://asset.localhost/${encodeURIComponent("C:\\pics\\a.png")}`,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("maps a WSL path to its host path first (crynta/terax-ai#1356)", async () => {
    invoke.mockResolvedValue("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.png");
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
    expect(await workspaceAssetUrl("/home/me/a.png", workspace)).toBe(
      `http://asset.localhost/${encodeURIComponent("\\\\wsl.localhost\\Ubuntu\\home\\me\\a.png")}`,
    );
    expect(invoke).toHaveBeenCalledWith("fs_host_path", {
      path: "/home/me/a.png",
      workspace,
    });
  });
});
