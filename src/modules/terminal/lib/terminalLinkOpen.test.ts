import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  hostname: vi.fn(async () => "Users-MacBook-Pro.local"),
  revealItemInDir: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/me" }));
vi.mock("@tauri-apps/plugin-os", () => ({ hostname: native.hostname }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: native.openUrl,
  revealItemInDir: native.revealItemInDir,
}));

import { openTerminalLink, setTerminalFileOpener } from "./terminalLinkOpen";

describe("opening terminal links", () => {
  afterEach(() => {
    vi.clearAllMocks();
    setTerminalFileOpener(null);
  });

  it("opens a file hyperlink from this machine in the editor", async () => {
    const opened = vi.fn();
    setTerminalFileOpener(opened);
    native.invoke.mockResolvedValue({ kind: "file" });

    await openTerminalLink(
      "file://users-macbook-pro.local/etc/hosts",
      null,
      () => {},
    );

    expect(native.invoke).toHaveBeenCalledWith("fs_stat", {
      path: "/etc/hosts",
      workspace: { kind: "local" },
    });
    expect(opened).toHaveBeenCalledWith("/etc/hosts", null, null);
    expect(native.revealItemInDir).not.toHaveBeenCalled();
  });

  it("shows a folder hyperlink in the file manager", async () => {
    const opened = vi.fn();
    setTerminalFileOpener(opened);
    native.invoke.mockResolvedValue({ kind: "dir" });

    await openTerminalLink(
      "file://users-macbook-pro.local/etc",
      null,
      () => {},
    );

    expect(native.revealItemInDir).toHaveBeenCalledWith("/etc");
    expect(opened).not.toHaveBeenCalled();
  });

  it("leaves another machine's files alone", async () => {
    await openTerminalLink("file://build-server/etc/hosts", null, () => {});

    expect(native.invoke).not.toHaveBeenCalled();
  });
});
