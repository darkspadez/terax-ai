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
