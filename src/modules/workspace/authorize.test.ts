import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@/modules/settings/store", () => ({ setLastWslDistro: vi.fn() }));

type Authorize = typeof import("./authorize");
let authorize: Authorize;

const local = { kind: "local" } as const;
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

beforeEach(async () => {
  invoke.mockReset();
  vi.resetModules();
  authorize = await import("./authorize");
});

describe("authorizing what the user opened", () => {
  it("names a root, a browsed folder and an opened file to the backend", async () => {
    invoke.mockResolvedValue("/real");
    await authorize.authorizeRoot("/srv/app", local);
    await authorize.authorizeFolder("/srv/app/link", local);
    await authorize.authorizeFileFolder("/etc/hosts", ubuntu);
    expect(invoke.mock.calls).toEqual([
      ["workspace_authorize", { path: "/srv/app", workspace: local }],
      [
        "workspace_authorize",
        { path: "/srv/app/link", workspace: local, opened: "folder" },
      ],
      [
        "workspace_authorize",
        { path: "/etc/hosts", workspace: ubuntu, opened: "file" },
      ],
    ]);
  });

  it("asks once per path and environment, and again after a refusal", async () => {
    invoke.mockResolvedValueOnce("/a").mockRejectedValueOnce("gone");
    expect(await authorize.authorizeFileFolder("/a/x.txt", local)).toBe(true);
    expect(await authorize.authorizeFileFolder("/a/x.txt", local)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);

    expect(await authorize.authorizeFileFolder("/a/x.txt", ubuntu)).toBe(false);
    invoke.mockResolvedValueOnce("/a");
    expect(await authorize.authorizeFileFolder("/a/x.txt", ubuntu)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("shares one request between callers while it is in flight", async () => {
    const answer = deferred();
    invoke.mockReturnValue(answer.promise);
    const first = authorize.authorizeFolder("/mnt/data", local);
    const second = authorize.authorizeFolder("/mnt/data", local);
    answer.resolve("/mnt/data");
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("authorizationSettled", () => {
  it("lets a read wait for the authorization of its own path", async () => {
    const answer = deferred();
    invoke.mockReturnValue(answer.promise);
    const events: string[] = [];
    void authorize.authorizeFileFolder("/opt/docs/a.md", local);

    const read = authorize
      .authorizationSettled("/opt/docs/a.md", local)
      .then(() => events.push("read"));
    const other = authorize
      .authorizationSettled("/opt/docs/b.md", local)
      .then(() => events.push("other read"));
    await other;
    expect(events).toEqual(["other read"]);

    answer.resolve("/opt/docs");
    await read;
    expect(events).toEqual(["other read", "read"]);
  });

  it("resolves after a refusal too, so the read reports the refusal", async () => {
    const answer = deferred();
    invoke.mockReturnValue(answer.promise);
    void authorize.authorizeRoot("/gone", local);
    const read = authorize.authorizationSettled("/gone", local);
    answer.reject("No such file or directory");
    await expect(read).resolves.toBeUndefined();
  });

  it("does not wait for the same path in another environment", async () => {
    invoke.mockReturnValue(new Promise(() => {}));
    void authorize.authorizeFolder("/home/me", ubuntu);
    await expect(
      authorize.authorizationSettled("/home/me", local),
    ).resolves.toBeUndefined();
  });
});
