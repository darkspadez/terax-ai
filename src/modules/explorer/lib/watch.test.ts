import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(),
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

const { parentDir, watchAdd, watchRemove } = await import("./watch");
const { authorizeFolder } = await import("@/modules/workspace/authorize");

const local = { kind: "local" } as const;

beforeEach(() => invoke.mockReset());

describe("watch changes", () => {
  it("wait for the folder's authorization, and a removal never overtakes them", async () => {
    let authorized!: (path: string) => void;
    invoke.mockImplementation((command: string) =>
      command === "workspace_authorize"
        ? new Promise((resolve) => {
            authorized = resolve;
          })
        : Promise.resolve(),
    );
    void authorizeFolder("/repo/data", local);
    watchAdd(["/repo/data"]);
    watchRemove(["/repo/data"]);
    watchAdd(["/repo/src"]);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("fs_watch_add", {
        paths: ["/repo/src"],
        files: [],
        workspace: local,
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(2);

    authorized("/repo/data");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(4));
    expect(invoke.mock.calls.slice(2).map(([command]) => command)).toEqual([
      "fs_watch_add",
      "fs_watch_remove",
    ]);
  });
});

describe("parentDir", () => {
  it("returns the folder holding a path", () => {
    expect(parentDir("/home/u/a.ts")).toBe("/home/u");
    expect(parentDir("C:/Users/u/a.ts")).toBe("C:/Users/u");
    expect(parentDir("C:\\Users\\u\\a.ts")).toBe("C:\\Users\\u");
  });

  it("keeps the slash of a drive root, which `D:` alone would not mean", () => {
    expect(parentDir("D:/a.ts")).toBe("D:/");
    expect(parentDir("d:\\a.ts")).toBe("d:\\");
  });

  it("treats the filesystem root as its own parent", () => {
    expect(parentDir("/a.ts")).toBe("/");
    expect(parentDir("a.ts")).toBe("a.ts");
  });
});
