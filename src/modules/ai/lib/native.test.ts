import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

type Native = typeof import("./native")["native"];
type Authorize = typeof import("@/modules/workspace/authorize");

let native: Native;
let authorize: Authorize;

const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const commandsRun = () => invoke.mock.calls.map(([command]) => command);

/** Lets every settled promise run its callbacks. */
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(async () => {
  invoke.mockReset();
  vi.resetModules();
  ({ native } = await import("./native"));
  authorize = await import("@/modules/workspace/authorize");
  const { useWorkspaceEnvStore } = await import("@/modules/workspace/env");
  useWorkspaceEnvStore.setState({ env: ubuntu });
});

describe("git commands on a path the page names", () => {
  const folder = "/home/me/new-project";
  const file = "/home/me/new-project/src/main.rs";
  const cases = [
    {
      command: "git_panel_snapshot",
      run: () => native.gitPanelSnapshot(folder),
      args: { cwd: folder },
      authorizing: () => authorize.authorizeRoot(folder),
    },
    {
      command: "git_resolve_repo",
      run: () => native.gitResolveRepo(folder),
      args: { cwd: folder },
      authorizing: () => authorize.authorizeRoot(folder),
    },
    {
      command: "git_discover_repos",
      run: () => native.gitDiscoverRepos(folder),
      args: { path: folder },
      authorizing: () => authorize.authorizeFolder(folder),
    },
    {
      command: "git_file_base",
      run: () => native.gitFileBase(file),
      args: { path: file },
      authorizing: () => authorize.authorizeFileFolder(file),
    },
  ];

  it.each(cases)(
    "$command waits for the authorization of its path in flight",
    async ({ command, run, args, authorizing }) => {
      const answer = deferred();
      invoke.mockImplementation((name: string) =>
        name === "workspace_authorize" ? answer.promise : Promise.resolve(null),
      );
      void authorizing();
      const result = run();
      await settle();
      expect(commandsRun()).toEqual(["workspace_authorize"]);

      answer.resolve(folder);
      await result;
      expect(invoke).toHaveBeenLastCalledWith(command, {
        ...args,
        workspace: ubuntu,
      });
    },
  );

  it("still runs after a refusal, which then reports it", async () => {
    const answer = deferred();
    invoke.mockImplementation((name: string) =>
      name === "workspace_authorize"
        ? answer.promise
        : Promise.reject("outside the authorized folders"),
    );
    void authorize.authorizeRoot(folder);
    const result = native.gitPanelSnapshot(folder);
    answer.reject("No such file or directory");
    await expect(result).rejects.toBe("outside the authorized folders");
  });

  it("runs in the environment the wait was judged in", async () => {
    const answer = deferred();
    invoke.mockImplementation((name: string) =>
      name === "workspace_authorize" ? answer.promise : Promise.resolve(null),
    );
    void authorize.authorizeRoot(folder);
    const result = native.gitPanelSnapshot(folder);
    const { useWorkspaceEnvStore } = await import("@/modules/workspace/env");
    useWorkspaceEnvStore.setState({ env: { kind: "local" } });
    answer.resolve(folder);
    await result;
    expect(invoke).toHaveBeenLastCalledWith("git_panel_snapshot", {
      cwd: folder,
      workspace: ubuntu,
    });
  });

  it("does not wait without an authorization in flight", async () => {
    invoke.mockResolvedValue(null);
    await native.gitPanelSnapshot(folder);
    expect(commandsRun()).toEqual(["git_panel_snapshot"]);
  });
});

describe("the AI tools' file and shell calls", () => {
  const dir = "/home/me/project";
  const cases: [string, () => Promise<unknown>][] = [
    ["fs_read_file", () => native.readFile(`${dir}/a.txt`)],
    ["fs_write_file", () => native.writeFile(`${dir}/a.txt`, "x")],
    ["fs_canonicalize", () => native.canonicalize(`${dir}/a.txt`)],
    ["fs_create_dir", () => native.createDir(`${dir}/new`)],
    ["fs_read_dir", () => native.readDir(dir)],
    ["fs_grep", () => native.grep({ pattern: "x", root: dir })],
    ["fs_glob", () => native.glob({ pattern: "**/*.ts", root: dir })],
    ["shell_run_command", () => native.runCommand("ls", dir)],
    ["shell_session_open", () => native.shellSessionOpen(dir)],
    ["shell_session_run", () => native.shellSessionRun(1, "ls", dir)],
    ["shell_bg_spawn", () => native.shellBgSpawn("bun run dev", dir)],
  ];

  // Without it the backend applies the app's setting, which must never
  // widen what the agent reaches.
  it.each(cases)("%s says it comes from the AI tools", async (command, run) => {
    invoke.mockResolvedValue(null);
    await run();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      command,
      expect.objectContaining({ origin: "ai" }),
    );
  });

  it("leaves no file or folder command untagged", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      `${process.cwd()}/src/modules/ai/lib/native.ts`,
      "utf8",
    );
    const named = [
      ...source.matchAll(/invoke<?[^(]*>?\(\s*"((?:fs|shell)_[a-z_]+)"/g),
    ].map((m) => m[1]);
    // These take no path or folder: a handle or session id only.
    const pathless = [
      "shell_session_close",
      "shell_bg_logs",
      "shell_bg_kill",
      "shell_bg_list",
    ];
    expect(named.filter((c) => !pathless.includes(c)).sort()).toEqual(
      cases.map(([command]) => command).sort(),
    );
  });

  it("leaves git, which the app's Source Control shares, to the authorized folders", async () => {
    invoke.mockResolvedValue(null);
    await native.gitStatus("/home/me/project");
    expect(invoke).toHaveBeenCalledWith("git_status", {
      repoRoot: "/home/me/project",
      workspace: ubuntu,
    });
  });
});

describe("file and shell commands in the AI module", () => {
  // Attach to Agent, an @ mention and the @ file list serve what the user
  // picked: the app's own features, under the app's setting. (A file dropped
  // on the composer is read through native, as the agent's.)
  const appFeatures = ["lib/pathAttachment.ts", "hooks/useWorkspaceFiles.ts"];

  it("go through native, which tags them as the AI tools'", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const root = `${process.cwd()}/src/modules/ai`;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !name.includes(".test.")) {
          files.push(path.slice(root.length + 1));
        }
      }
    };
    walk(root);
    const direct = files.filter((file) =>
      /invoke<?[^(]*>?\(\s*"(?:fs|shell)_/.test(
        readFileSync(`${root}/${file}`, "utf8"),
      ),
    );
    expect(direct.sort()).toEqual(["lib/native.ts", ...appFeatures].sort());
  });
});
