import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);

const runtime = vi.hoisted(() => {
  const state = {
    detected: {} as Record<string, string | null>,
    setDetected: vi.fn((command: string, path: string | null) => {
      state.detected[command] = path;
    }),
    clearDetected: vi.fn((command: string) => {
      delete state.detected[command];
    }),
    resetDetections: vi.fn((_enabled: readonly string[]) => {
      state.detected = {};
    }),
  };
  return { state, useLspRuntimeStore: { getState: () => state } };
});

vi.mock("./runtimeStore", () => ({ useLspRuntimeStore: runtime.useLspRuntimeStore }));

import { usePreferencesStore } from "@/modules/settings/preferences";
import { detectBinary, redetectBinary } from "./detect";

describe("LSP binary detection", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ terminalShell: "", lspActivation: {} });
    core.invoke.mockReset();
    runtime.state.detected = {};
    runtime.state.setDetected.mockClear();
    runtime.state.clearDetected.mockClear();
    runtime.state.resetDetections.mockClear();
  });

  it("coalesces concurrent detections of the same command into one probe", async () => {
    let release: ((v: string | null) => void) | undefined;
    core.invoke.mockReturnValue(
      new Promise<string | null>((r) => {
        release = r;
      }),
    );

    const first = detectBinary("rust-analyzer");
    const second = detectBinary("rust-analyzer");
    release?.("/usr/bin/rust-analyzer");

    expect(await first).toBe("/usr/bin/rust-analyzer");
    expect(await second).toBe("/usr/bin/rust-analyzer");
    expect(core.invoke).toHaveBeenCalledTimes(1);
  });

  it("serves later calls from the runtime store without probing again", async () => {
    core.invoke.mockResolvedValue("/usr/local/bin/typescript-language-server");

    await detectBinary("typescript-language-server");
    await detectBinary("typescript-language-server");

    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(runtime.state.setDetected).toHaveBeenCalledWith(
      "typescript-language-server",
      "/usr/local/bin/typescript-language-server",
    );
  });

  it("caches a failed probe as null instead of retrying forever", async () => {
    core.invoke.mockRejectedValue(new Error("spawn failed"));

    await expect(detectBinary("gopls")).resolves.toBeNull();
    await expect(detectBinary("gopls")).resolves.toBeNull();

    expect(core.invoke).toHaveBeenCalledTimes(1);
    expect(runtime.state.detected.gopls).toBeNull();
  });

  it("probes distinct commands independently", async () => {
    core.invoke.mockImplementation((_cmd: string, args: { command: string }) =>
      Promise.resolve(args.command === "pyright" ? "/bin/pyright" : null),
    );

    await expect(detectBinary("pyright")).resolves.toBe("/bin/pyright");
    await expect(detectBinary("ruff")).resolves.toBeNull();

    expect(core.invoke).toHaveBeenCalledTimes(2);
  });

  it("redetect drops the cached answer and probes again", async () => {
    core.invoke
      .mockResolvedValueOnce("/old/path")
      .mockResolvedValueOnce("/new/path");

    await detectBinary("rust-analyzer");
    await expect(redetectBinary("rust-analyzer")).resolves.toBe("/new/path");

    expect(runtime.state.clearDetected).toHaveBeenCalledWith("rust-analyzer");
    expect(core.invoke).toHaveBeenCalledTimes(2);
  });

  // crynta/terax-ai#1039: servers are looked up through the shell set in Terax.
  it("looks binaries up through the configured terminal shell", async () => {
    core.invoke.mockResolvedValue("/usr/bin/gopls");
    usePreferencesStore.setState({ terminalShell: "/usr/bin/fish" });

    await detectBinary("gopls");

    expect(core.invoke).toHaveBeenCalledWith("lsp_detect", {
      command: "gopls",
      shell: "/usr/bin/fish",
    });
  });

  it("asks for the login shell when none is configured", async () => {
    core.invoke.mockResolvedValue(null);

    await detectBinary("gopls");

    expect(core.invoke).toHaveBeenCalledWith("lsp_detect", {
      command: "gopls",
      shell: null,
    });
  });

  it("forgets lookups when the shell changes, dropping one still in flight", async () => {
    let releaseOld: ((v: string | null) => void) | undefined;
    core.invoke.mockReturnValueOnce(
      new Promise<string | null>((r) => {
        releaseOld = r;
      }),
    );
    usePreferencesStore.setState({
      lspActivation: { gopls: "enabled", ruff: "dismissed" },
    });
    const old = detectBinary("gopls");

    usePreferencesStore.setState({ terminalShell: "/usr/bin/fish" });
    expect(runtime.state.resetDetections).toHaveBeenCalledWith(["gopls"]);

    releaseOld?.(null);
    await expect(old).resolves.toBeNull();
    expect(runtime.state.detected.gopls).toBeUndefined();

    core.invoke.mockResolvedValueOnce("/home/me/go/bin/gopls");
    await expect(detectBinary("gopls")).resolves.toBe("/home/me/go/bin/gopls");
    expect(core.invoke).toHaveBeenLastCalledWith("lsp_detect", {
      command: "gopls",
      shell: "/usr/bin/fish",
    });
  });

  it("redetect re-probes while the previous probe is still pending", async () => {
    let releaseFirst: ((v: string | null) => void) | undefined;
    core.invoke.mockReturnValueOnce(
      new Promise<string | null>((r) => {
        releaseFirst = r;
      }),
    );

    const stuck = detectBinary("rust-analyzer");
    core.invoke.mockResolvedValueOnce("/late/path");

    await expect(redetectBinary("rust-analyzer")).resolves.toBe("/late/path");
    expect(core.invoke).toHaveBeenCalledTimes(2);

    releaseFirst?.(null);
    await expect(stuck).resolves.toBeNull();
  });
});
