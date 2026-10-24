import type { Tab } from "@/modules/tabs/lib/useTabs";
import type { WorkspaceEnv } from "@/modules/workspace";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceMeta } from "./store";

const authorizeRoot = vi.fn(async () => true);
const authorizeFileFolder = vi.fn(async () => true);
vi.mock("@/modules/workspace/authorize", () => ({
  authorizeRoot: (...a: unknown[]) => authorizeRoot(...(a as [])),
  authorizeFileFolder: (...a: unknown[]) => authorizeFileFolder(...(a as [])),
}));

const { deferRestoreGrants, grantDeferredSpace, planRestoreGrants } =
  await import("./restoreGrants");

const ubuntu = { kind: "wsl", distro: "Ubuntu" } as const;
const local = { kind: "local" } as const;

function space(
  id: string,
  root: string | null,
  env: WorkspaceEnv = local,
): SpaceMeta {
  return { id, name: id, root, env, createdAt: 1, updatedAt: 1 };
}

const terminal = (spaceId: string, ...cwds: string[]): Tab => ({
  id: 1,
  kind: "terminal",
  spaceId,
  title: "shell",
  activeLeafId: 1,
  paneTree: {
    kind: "split",
    id: 2,
    dir: "row",
    children: cwds.map((cwd, i) => ({ kind: "leaf", id: 3 + i, cwd })),
  },
});

const file = (spaceId: string, kind: "editor" | "markdown", path: string) =>
  ({ id: 9, kind, spaceId, title: path, path }) as Tab;

beforeEach(() => {
  authorizeRoot.mockClear();
  authorizeFileFolder.mockClear();
});

describe("planRestoreGrants", () => {
  it("authorizes roots, terminal folders and open files' folders, once each", () => {
    const plan = planRestoreGrants(
      [space("a", "/srv/app"), space("b", null)],
      [
        terminal("a", "/srv/app", "/srv/app/api"),
        file("a", "editor", "/etc/hosts"),
        file("b", "markdown", "/opt/docs/readme.md"),
        file("b", "editor", "/opt/docs/readme.md"),
        {
          ...file("a", "editor", "/x"),
          kind: "preview",
          url: "http://x",
        } as Tab,
      ],
      "a",
    );
    expect(plan.now).toEqual([
      { path: "/srv/app", file: false, env: local },
      { path: "/srv/app/api", file: false, env: local },
      { path: "/etc/hosts", file: true, env: local },
      { path: "/opt/docs/readme.md", file: true, env: local },
    ]);
    expect(plan.later.size).toBe(0);
  });

  it("keeps an inactive WSL space for later and grants the active one now", () => {
    const plan = planRestoreGrants(
      [space("win", "C:/work", local), space("wsl", "/home/me", ubuntu)],
      [file("wsl", "editor", "/home/me/a.txt"), terminal("win", "C:/work")],
      "win",
    );
    expect(plan.now).toEqual([{ path: "C:/work", file: false, env: local }]);
    expect(plan.later).toEqual(
      new Map([
        [
          "wsl",
          [
            { path: "/home/me", file: false, env: ubuntu },
            { path: "/home/me/a.txt", file: true, env: ubuntu },
          ],
        ],
      ]),
    );

    const active = planRestoreGrants(
      [space("wsl", "/home/me", ubuntu)],
      [file("wsl", "editor", "/home/me/a.txt")],
      "wsl",
    );
    expect(active.now).toHaveLength(2);
    expect(active.later.size).toBe(0);
  });
});

describe("grantDeferredSpace", () => {
  it("authorizes a deferred space once, when it is first activated", () => {
    deferRestoreGrants(
      new Map([
        [
          "wsl",
          [
            { path: "/home/me", file: false, env: ubuntu },
            { path: "/home/me/a.txt", file: true, env: ubuntu },
          ],
        ],
      ]),
    );
    grantDeferredSpace("other");
    expect(authorizeRoot).not.toHaveBeenCalled();

    grantDeferredSpace("wsl");
    expect(authorizeRoot).toHaveBeenCalledWith("/home/me", ubuntu);
    expect(authorizeFileFolder).toHaveBeenCalledWith("/home/me/a.txt", ubuntu);

    grantDeferredSpace("wsl");
    expect(authorizeRoot).toHaveBeenCalledTimes(1);
  });
});
