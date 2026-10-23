import type { OpenProject } from "@/modules/skills/types";
import { describe, expect, it } from "vitest";
import {
  effectiveRecord,
  parseRecords,
  projectConfigs,
  projectServerConfig,
  type ProjectServers,
  type ProjectServerView,
  recordOf,
} from "./projectServers";

/** `${NAME}` as written in a configuration file. */
const ref = (name: string) => ["$", "{", name, "}"].join("");

const ID = "prj-0123456789ab-ba9876543210";
const project: OpenProject = {
  key: "/work/p",
  root: "/work/p",
  workspace: { kind: "local" },
};

function view(overrides: Partial<ProjectServerView> = {}): ProjectServerView {
  return {
    id: ID,
    name: "db",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "db-mcp", ref("DB_URL")],
      env: [{ name: "TOKEN", secret: false, value: ref("TOKEN") }],
      cwd: null,
    },
    entryHash: "h1",
    variables: ["DB_URL", "TOKEN"],
    warnings: [],
    problem: null,
    ...overrides,
  };
}

describe("project servers", () => {
  it("run on, untrusted, until the user says otherwise", () => {
    const config = projectServerConfig(view(), project, undefined);
    expect(config).toMatchObject({
      id: ID,
      name: "db",
      source: "project:/work/p",
      enabled: true,
      trusted: false,
      tools: {},
      secretsRevision: 0,
    });
    expect(config?.transport).toMatchObject({
      command: "npx",
      args: ["-y", "db-mcp", ref("DB_URL")],
    });
  });

  it("keep Trusted and Always allow only for the entry they were chosen for", () => {
    const record = {
      entryHash: "h1",
      enabled: false,
      trusted: true,
      tools: { read: "allow", drop: "deny" } as const,
    };
    expect(effectiveRecord(record, "h1")).toEqual(record);
    expect(effectiveRecord(record, "h2")).toEqual({
      enabled: false,
      trusted: false,
      tools: { drop: "deny" },
    });
    expect(
      projectServerConfig(view({ entryHash: "h2" }), project, record),
    ).toMatchObject({
      enabled: false,
      trusted: false,
      tools: { drop: "deny" },
    });
    expect(recordOf({ enabled: true, trusted: true, tools: {} }, "h3")).toEqual(
      { entryHash: "h3", enabled: true, trusted: true, tools: {} },
    );
  });

  it("leave out what cannot run", () => {
    expect(
      projectServerConfig(view({ problem: "no command" }), project, undefined),
    ).toBe(null);
    expect(
      projectServerConfig(
        view({ transport: { type: "ws" } }),
        project,
        undefined,
      ),
    ).toBe(null);
    expect(projectServerConfig(view({ id: "x" }), project, undefined)).toBe(
      null,
    );
    const remote = projectServerConfig(
      view({
        transport: {
          type: "http",
          url: `https://${ref("HOST")}/mcp`,
          headers: [],
        },
      }),
      project,
      undefined,
    );
    expect(remote?.transport).toMatchObject({
      url: `https://${ref("HOST")}/mcp`,
    });
  });

  it("read stored choices strictly", () => {
    expect(
      parseRecords({
        [ID]: {
          entryHash: "h",
          enabled: false,
          trusted: "yes",
          tools: { a: "allow", b: "maybe" },
        },
        "not-a-project-id": { entryHash: "h" },
        "prj-0123456789ab-000000000000": { enabled: true },
      }),
    ).toEqual({
      [ID]: {
        entryHash: "h",
        enabled: false,
        trusted: false,
        tools: { a: "allow" },
      },
    });
    expect(parseRecords(null)).toEqual({});
  });

  it("list every usable server of the listed projects", () => {
    const listed: ProjectServers[] = [
      {
        project,
        path: "/work/p/.mcp.json",
        state: "allowed",
        hash: "f1",
        problem: null,
        entries: [],
        servers: [
          view(),
          view({ id: "prj-0123456789ab-111111111111", problem: "x" }),
        ],
      },
    ];
    expect(projectConfigs(listed, {}).map((s) => s.id)).toEqual([ID]);
  });
});
