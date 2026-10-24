import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const toastError = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => toastError(...a) },
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

const { openInDefaultApp } = await import("./openDefault");
const { useWorkspaceEnvStore } = await import("@/modules/workspace");

beforeEach(() => {
  invoke.mockReset();
  toastError.mockReset();
  useWorkspaceEnvStore.setState({ env: { kind: "local" } });
});

describe("openInDefaultApp", () => {
  it("asks the backend once and never carries an approval", async () => {
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
    useWorkspaceEnvStore.setState({ env: workspace });
    invoke.mockResolvedValue("opened");
    await openInDefaultApp("/home/me/setup.sh");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fs_open_default", {
      path: "/home/me/setup.sh",
      workspace,
    });
  });

  it("does nothing more when the user declines in the native dialog", async () => {
    invoke.mockResolvedValue("cancelled");
    await openInDefaultApp("/w/setup.exe");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports a refusal", async () => {
    invoke.mockRejectedValue("/etc/passwd is outside the authorized folders");
    await openInDefaultApp("/etc/passwd");
    expect(toastError).toHaveBeenCalledWith("Could not open the file", {
      description: "/etc/passwd is outside the authorized folders",
    });
  });
});
