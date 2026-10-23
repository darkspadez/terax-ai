import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "./config";
import {
  alreadyPresent,
  describeImported,
  type ImportedServer,
  importedConfig,
  importProblem,
  secretNotes,
  uniqueName,
} from "./importConfig";

/** `${NAME}` as written in a configuration file. */
const ref = (name: string) => ["$", "{", name, "}"].join("");

function found(overrides: Partial<ImportedServer> = {}): ImportedServer {
  return {
    key: "github",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: [
        {
          name: "GITHUB_TOKEN",
          value: null,
          secret: true,
          input: null,
          template: null,
        },
        {
          name: "LOG_LEVEL",
          value: "info",
          secret: false,
          input: null,
          template: null,
        },
      ],
      cwd: null,
    },
    oauth: null,
    warnings: [],
    problem: null,
    fingerprint: "f",
    ...overrides,
  };
}

const existing: McpServerConfig = {
  id: "6f1c2a5e-0b9d-4c3e-8f7a-1d2e3f4a5b6c",
  name: "GitHub",
  source: "settings",
  enabled: true,
  trusted: true,
  tools: {},
  secretsRevision: 0,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: [],
    cwd: null,
  },
};

describe("importing servers", () => {
  it("imports a server off and untrusted, its secrets only named", () => {
    const config = importedConfig(found(), "claude-desktop", "id-1", "github");
    expect(config).toEqual({
      id: "id-1",
      name: "github",
      source: "imported:claude-desktop",
      enabled: false,
      trusted: false,
      tools: {},
      secretsRevision: 0,
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: [
          { name: "GITHUB_TOKEN", secret: true },
          { name: "LOG_LEVEL", secret: false, value: "info" },
        ],
        cwd: null,
      },
    });
    expect(JSON.stringify(config)).not.toContain("ghp_");
  });

  it("keeps a Claude Code sign-in client", () => {
    const config = importedConfig(
      found({
        transport: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: [],
        },
        oauth: { clientId: "abc", scopes: "read", callbackPort: 8080 },
      }),
      "claude-code",
      "id",
      "x",
    );
    expect(config?.transport).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: [],
      oauth: {
        clientId: "abc",
        clientSecret: false,
        scopes: "read",
        callbackPort: 8080,
      },
    });
  });

  it("marks servers already configured", () => {
    expect(alreadyPresent(found(), [existing])).toBe(true);
    expect(
      alreadyPresent(
        found({
          transport: {
            type: "stdio",
            command: "uvx",
            args: ["x"],
            env: [],
            cwd: null,
          },
        }),
        [existing],
      ),
    ).toBe(false);
    const remote = found({
      transport: { type: "http", url: "https://a.example/mcp/", headers: [] },
    });
    expect(
      alreadyPresent(remote, [
        {
          ...existing,
          transport: {
            type: "http",
            url: "https://a.example/mcp",
            headers: [],
          },
        },
      ]),
    ).toBe(true);
  });

  it("refuses what it cannot run", () => {
    expect(importProblem(found({ problem: "WebSocket" }))).toBe("WebSocket");
    expect(importProblem(found({ transport: null }))).toBeTruthy();
    const badUrl = found({
      transport: { type: "http", url: ref("env:URL"), headers: [] },
    });
    expect(importProblem(badUrl)).toBeTruthy();
    expect(importedConfig(badUrl, "cursor", "i", "n")).toBe(null);
  });

  it("finds a free name", () => {
    expect(uniqueName("github", new Set())).toBe("github");
    expect(uniqueName("GitHub", new Set(["github"]))).toBe("GitHub (2)");
    expect(uniqueName("a", new Set(["a", "a (2)"]))).toBe("a (3)");
    expect(uniqueName("x".repeat(80), new Set())).toHaveLength(64);
    expect(uniqueName("x".repeat(80), new Set(["x".repeat(64)]))).toHaveLength(
      64,
    );
    expect(uniqueName("  \n ", new Set())).toBe("server");
  });

  it("says where each value goes", () => {
    const withInput = found({
      transport: {
        type: "http",
        url: "https://x.example/mcp",
        headers: [
          {
            name: "Authorization",
            value: null,
            secret: true,
            input: "API key",
            template: `Bearer ${ref("input:key")}`,
          },
        ],
      },
    });
    expect(secretNotes(found())).toEqual({
      keychain: ["GITHUB_TOKEN"],
      toFill: [],
    });
    expect(secretNotes(withInput).toFill[0].input).toBe("API key");
    expect(describeImported(withInput)).toBe("https://x.example/mcp");
  });
});
