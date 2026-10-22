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

const { confirmRun, openInDefaultApp, useRunPromptStore } = await import(
  "./openDefault"
);
const { useWorkspaceEnvStore } = await import("@/modules/workspace");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  toastError.mockReset();
  useRunPromptStore.setState({ pending: null });
  useWorkspaceEnvStore.setState({ env: { kind: "local" } });
});

describe("openInDefaultApp", () => {
  it("opens a document with one call and no question", async () => {
    invoke.mockResolvedValue("opened");
    await openInDefaultApp("/w/report.pdf");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("fs_open_default", {
      path: "/w/report.pdf",
      workspace: { kind: "local" },
    });
    expect(useRunPromptStore.getState().pending).toBeNull();
  });

  it("runs a program only after the user confirms, in the same workspace", async () => {
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;
    useWorkspaceEnvStore.setState({ env: workspace });
    invoke.mockResolvedValueOnce("confirm").mockResolvedValueOnce("opened");
    const done = openInDefaultApp("/home/me/setup.sh");
    await flush();
    expect(useRunPromptStore.getState().pending?.path).toBe(
      "/home/me/setup.sh",
    );
    expect(invoke).toHaveBeenCalledTimes(1);

    useWorkspaceEnvStore.setState({ env: { kind: "local" } });
    useRunPromptStore.getState().answer(true);
    await done;
    expect(invoke).toHaveBeenLastCalledWith("fs_open_default", {
      path: "/home/me/setup.sh",
      workspace,
      confirmed: true,
    });
  });

  it("does nothing more when the user declines", async () => {
    invoke.mockResolvedValue("confirm");
    const done = openInDefaultApp("/w/setup.exe");
    await flush();
    useRunPromptStore.getState().answer(false);
    await done;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports a refusal", async () => {
    invoke.mockRejectedValue("path is outside the authorized workspace");
    await openInDefaultApp("/etc/passwd");
    expect(toastError).toHaveBeenCalledWith("Could not open the file", {
      description: "path is outside the authorized workspace",
    });
  });
});

describe("confirmRun", () => {
  it("declines an open question when a newer one arrives", async () => {
    const first = confirmRun("/w/a.sh");
    const second = confirmRun("/w/b.sh");
    expect(await first).toBe(false);
    expect(useRunPromptStore.getState().pending?.path).toBe("/w/b.sh");
    useRunPromptStore.getState().answer(true);
    expect(await second).toBe(true);
    expect(useRunPromptStore.getState().pending).toBeNull();
  });
});
