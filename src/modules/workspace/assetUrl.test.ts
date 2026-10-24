import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, protocol = "asset") =>
    `http://${protocol}.localhost/${encodeURIComponent(path)}`,
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

  it("loads through the backend's own scheme while the app may access all folders", async () => {
    expect(
      await workspaceAssetUrl("D:\\photos\\a.png", { kind: "local" }, true),
    ).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("D:\\photos\\a.png")}`,
    );
    invoke.mockResolvedValue("\\\\wsl.localhost\\Ubuntu\\srv\\a.png");
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
    expect(await workspaceAssetUrl("/srv/a.png", workspace, true)).toBe(
      `http://oarlock-asset.localhost/${encodeURIComponent("\\\\wsl.localhost\\Ubuntu\\srv\\a.png")}`,
    );
  });
});
