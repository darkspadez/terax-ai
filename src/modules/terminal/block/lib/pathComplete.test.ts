import { beforeEach, describe, expect, it, vi } from "vitest";

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => core);

const workspace = vi.hoisted(() => ({
  env: { kind: "local" } as { kind: "local" } | { kind: "wsl"; distro: string },
}));

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => workspace.env,
}));

const platform = vi.hoisted(() => ({ windows: false }));

vi.mock("@/lib/platform", () => ({
  get IS_WINDOWS() {
    return platform.windows;
  },
}));

const cm = vi.hoisted(() => ({
  startCompletion: vi.fn(),
}));

vi.mock("@codemirror/autocomplete", () => cm);

import {
  completionWord,
  currentPathStyle,
  pathCompletions,
  pathQuery,
  pathValidFor,
  type PathStyle,
} from "./pathComplete";

type InvokeArgs = { path: string; showHidden: boolean; workspace: unknown };

function entry(
  name: string,
  kind: "file" | "dir" | "symlink" = "file",
): { name: string; kind: string; size: number; mtime: number } {
  return { name, kind, size: 0, mtime: 0 };
}

function fakeView() {
  return { dispatch: vi.fn() };
}

function readDirPath(): string | undefined {
  return (core.invoke.mock.lastCall?.[1] as InvokeArgs | undefined)?.path;
}

// What CodeMirror's matchBefore takes from the line before the cursor.
function wordBefore(line: string, style: PathStyle): string {
  const re = new RegExp(`(?:${completionWord(style).source})$`);
  return re.exec(line)?.[0] ?? "";
}

describe("block-mode path completion", () => {
  beforeEach(() => {
    core.invoke.mockReset();
    cm.startCompletion.mockClear();
    workspace.env = { kind: "local" };
    platform.windows = false;
  });

  it("lists a bare token against cwd with dirs before files", async () => {
    core.invoke.mockResolvedValue([
      entry("README.md"),
      entry("src", "dir"),
      entry("package.json"),
    ]);

    const res = await pathCompletions("", "/repo", "posix");

    expect(core.invoke).toHaveBeenCalledWith("fs_read_dir", {
      path: "/repo",
      showHidden: false,
      workspace: { kind: "local" },
    } satisfies InvokeArgs);
    expect(res?.fromOffset).toBe(0);
    expect(res?.options.map((o) => o.label)).toEqual([
      "src/",
      "README.md",
      "package.json",
    ]);
    expect(res?.options.map((o) => o.type)).toEqual([
      "type",
      "variable",
      "variable",
    ]);
  });

  it("splits the token at the last slash and reports the dir part as fromOffset", async () => {
    core.invoke.mockResolvedValue([entry("main.ts")]);

    const res = await pathCompletions("lib/ma", "/repo", "posix");

    expect(readDirPath()).toBe("/repo/lib");
    expect(res?.fromOffset).toBe(4);
    expect(res?.options.map((o) => o.label)).toEqual(["main.ts"]);
  });

  it("uses an absolute dir part as-is", async () => {
    core.invoke.mockResolvedValue([]);

    const res = await pathCompletions("/etc/ngi", "/repo", "posix");

    expect(readDirPath()).toBe("/etc/");
    expect(res).toEqual({ fromOffset: 5, options: [] });
  });

  it("lists the root itself when the cwd is the root", async () => {
    core.invoke.mockResolvedValue([entry("usr", "dir")]);

    await pathCompletions("", "/", "posix");
    expect(readDirPath()).toBe("/");

    await pathCompletions("usr/lo", "/", "posix");
    expect(readDirPath()).toBe("/usr");
  });

  it("refuses home-relative tokens without touching the backend", async () => {
    expect(await pathCompletions("~/.ssh/id", "/repo", "posix")).toBeNull();
    expect(await pathCompletions("~\\.ssh\\id", "C:/repo", "windows")).toBeNull();
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("requests hidden entries only when the base starts with a dot", async () => {
    core.invoke.mockResolvedValue([]);

    await pathCompletions(".", "/repo", "posix");
    await pathCompletions("normal", "/repo", "posix");

    const calls = core.invoke.mock.calls.map((c) => c[1] as InvokeArgs);
    expect(calls[0].showHidden).toBe(true);
    expect(calls[1].showHidden).toBe(false);
  });

  it("filters case-insensitively on the base prefix", async () => {
    core.invoke.mockResolvedValue([
      entry("Src", "dir"),
      entry("readme.md"),
      entry("node_modules", "dir"),
    ]);

    const res = await pathCompletions("re", "/repo", "posix");

    expect(res?.options.map((o) => o.label)).toEqual(["readme.md"]);
  });

  it("treats symlinks as files", async () => {
    core.invoke.mockResolvedValue([entry("link", "symlink")]);

    const res = await pathCompletions("", "/repo", "posix");

    expect(res?.options.map((o) => o.label)).toEqual(["link"]);
  });

  it("dir applies insert the trailing slash and retrigger completion", async () => {
    core.invoke.mockResolvedValue([entry("src", "dir")]);

    const res = await pathCompletions("", "/repo", "posix");
    const dir = res?.options[0];
    if (typeof dir?.apply !== "function")
      throw new Error("dir completion missing apply");

    const view = fakeView();
    dir.apply(view as never, dir, 3, 5);

    expect(view.dispatch).toHaveBeenCalledWith({
      changes: { from: 3, to: 5, insert: "src/" },
      selection: { anchor: 7 },
    });
    expect(cm.startCompletion).toHaveBeenCalledWith(view);
  });

  it("caps the option list at 200 entries", async () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      entry(`f${String(i).padStart(3, "0")}.txt`),
    );
    core.invoke.mockResolvedValue(many);

    const res = await pathCompletions("", "/repo", "posix");

    expect(res?.options).toHaveLength(200);
  });

  it("returns null when the backend rejects the read", async () => {
    core.invoke.mockRejectedValue(new Error("denied"));

    const res = await pathCompletions("", "/repo", "posix");

    expect(res).toBeNull();
  });
});

describe("windows path syntax", () => {
  beforeEach(() => {
    core.invoke.mockReset();
    cm.startCompletion.mockClear();
  });

  it("splits backslash tokens and keeps their offsets", async () => {
    core.invoke.mockResolvedValue([entry("main.ts"), entry("util", "dir")]);

    const res = await pathCompletions("lib\\ma", "C:/repo", "windows");

    expect(readDirPath()).toBe("C:/repo/lib");
    expect(res?.fromOffset).toBe(4);
    expect(res?.options.map((o) => o.label)).toEqual(["main.ts"]);
  });

  it("lists drive-absolute paths with either separator", () => {
    expect(pathQuery("C:\\repo\\lib\\ma", "D:/work", "windows")).toEqual({
      dir: "C:/repo/lib/",
      base: "ma",
      fromOffset: 12,
      sep: "\\",
    });
    expect(pathQuery("c:/repo/ma", "D:/work", "windows")?.dir).toBe(
      "c:/repo/",
    );
    expect(pathQuery("C:\\", "D:/work", "windows")?.dir).toBe("C:/");
  });

  it("roots a leading separator on the drive of the cwd", () => {
    expect(pathQuery("\\tools\\b", "D:/work", "windows")?.dir).toBe(
      "D:/tools/",
    );
  });

  it("keeps UNC shares absolute", () => {
    expect(
      pathQuery("\\\\server\\share\\do", "C:/repo", "windows")?.dir,
    ).toBe("//server/share/");
  });

  it("accepts a cwd that still has backslashes", () => {
    expect(pathQuery("src\\", "C:\\repo", "windows")?.dir).toBe(
      "C:/repo/src",
    );
  });

  it("completes directories with the separator the user typed", async () => {
    core.invoke.mockResolvedValue([entry("src", "dir")]);

    const back = await pathCompletions("lib\\s", "C:/repo", "windows");
    const fwd = await pathCompletions("lib/s", "C:/repo", "windows");
    const bare = await pathCompletions("s", "C:/repo", "windows");

    expect(back?.options[0].label).toBe("src\\");
    expect(fwd?.options[0].label).toBe("src/");
    expect(bare?.options[0].label).toBe("src/");
  });

  it("takes the whole path as the completion word", () => {
    expect(wordBefore("cd C:\\Users\\me\\Doc", "windows")).toBe(
      "C:\\Users\\me\\Doc",
    );
    expect(wordBefore("ls lib\\ma", "windows")).toBe("lib\\ma");
    expect(wordBefore("ls lib\\ma", "posix")).toBe("ma");
    expect(pathValidFor("windows").test("src")).toBe(true);
    expect(pathValidFor("windows").test("src\\")).toBe(false);
    expect(pathValidFor("posix").test("a\\b")).toBe(true);
  });

  it("leaves backslashes alone in POSIX shells, where they escape", () => {
    expect(pathQuery("my\\ fi", "/repo", "posix")).toEqual({
      dir: "/repo",
      base: "my\\ fi",
      fromOffset: 0,
      sep: "/",
    });
    expect(pathQuery("C:/x/y", "/repo", "posix")?.dir).toBe("/repo/C:/x");
  });

  it("uses windows syntax only for local shells on Windows", () => {
    platform.windows = false;
    workspace.env = { kind: "local" };
    expect(currentPathStyle()).toBe("posix");

    platform.windows = true;
    expect(currentPathStyle()).toBe("windows");

    workspace.env = { kind: "wsl", distro: "Ubuntu" };
    expect(currentPathStyle()).toBe("posix");
  });
});
