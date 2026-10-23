import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));
vi.mock("@/modules/settings/preferences", () => ({ usePreferencesStore: {} }));
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({ toast: {} }));

import { useWorkspaceEnvStore } from "@/modules/workspace";
import { tauriDocumentIo } from "./useDocument";

const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
const host = { kind: "local" };

const themeFile =
  "C:\\Users\\me\\AppData\\Roaming\\sh.oarlock.app\\themes\\mine.oarlock-theme";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ kind: "text", content: "{}", size: 2, mtime: 1 });
  useWorkspaceEnvStore.setState({ env: ubuntu });
});

describe("the editor's document IO in a WSL window", () => {
  it("reads, stats and saves a host file such as a theme on the host", async () => {
    await tauriDocumentIo.read(themeFile, false);
    await tauriDocumentIo.mtime(themeFile);
    await tauriDocumentIo.write(themeFile, "{}");
    expect(invoke.mock.calls).toEqual([
      ["fs_read_file", { path: themeFile, workspace: host, force: false }],
      ["fs_stat", { path: themeFile, workspace: host }],
      [
        "fs_write_file",
        { path: themeFile, content: "{}", workspace: host, source: "editor" },
      ],
    ]);
  });

  it("keeps a file inside the distro in the window's environment", async () => {
    const file = "/home/me/project/README.md";
    await tauriDocumentIo.read(file, true);
    await tauriDocumentIo.write(file, "# Notes");
    expect(invoke.mock.calls).toEqual([
      ["fs_read_file", { path: file, workspace: ubuntu, force: true }],
      [
        "fs_write_file",
        { path: file, content: "# Notes", workspace: ubuntu, source: "editor" },
      ],
    ]);
  });
});
