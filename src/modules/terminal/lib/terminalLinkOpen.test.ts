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

import {
  openTerminalLink,
  openTerminalPreview,
  setTerminalFileOpener,
  setTerminalPreviewOpener,
} from "./terminalLinkOpen";

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

    // The click authorizes the file's folder, before anything reads it.
    expect(native.invoke.mock.calls).toEqual([
      [
        "workspace_authorize",
        { path: "/etc/hosts", workspace: { kind: "local" }, opened: "file" },
      ],
      ["fs_stat", { path: "/etc/hosts", workspace: { kind: "local" } }],
    ]);
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

  it("opens a web link in the preview when the app takes it, else in the browser", async () => {
    setTerminalPreviewOpener((url) => url.startsWith("http://localhost"));
    const settled = vi.fn();

    await openTerminalLink("http://localhost:3000/", null, settled);
    expect(native.openUrl).not.toHaveBeenCalled();

    await openTerminalLink("https://terax.app/", null, settled);
    expect(native.openUrl).toHaveBeenCalledWith("https://terax.app/");
    expect(settled).toHaveBeenCalledOnce();
    setTerminalPreviewOpener(null);
  });

  it("leaves another machine's files alone", async () => {
    await openTerminalLink("file://build-server/etc/hosts", null, () => {});

    expect(native.invoke).not.toHaveBeenCalled();
  });
});

describe("terminal link preview routing", () => {
  it("sends links to the browser unless the app takes them", () => {
    expect(openTerminalPreview("http://localhost:5173")).toBe(false);
    const seen: string[] = [];
    setTerminalPreviewOpener((url) => {
      seen.push(url);
      return url.includes("localhost");
    });
    expect(openTerminalPreview("http://localhost:5173")).toBe(true);
    expect(openTerminalPreview("https://terax.app")).toBe(false);
    setTerminalPreviewOpener(null);
    expect(openTerminalPreview("http://localhost:5173")).toBe(false);
    expect(seen).toEqual(["http://localhost:5173", "https://terax.app"]);
  });
});
