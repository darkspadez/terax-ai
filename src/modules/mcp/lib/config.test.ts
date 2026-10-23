import { describe, expect, it } from "vitest";
import {
  isAbsolutePath,
  isHttpUrl,
  isValidHeaderName,
  launchKey,
  type McpServerConfig,
  parseServers,
  secretRefs,
  splitValues,
  validateServer,
} from "./config";

const ID = "6f1c2a5e-0b9d-4c3e-8f7a-1d2e3f4a5b6c";

function stdio(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: ID,
    name: "everything",
    source: "settings",
    enabled: true,
    trusted: false,
    tools: {},
    secretsRevision: 0,
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
      env: [],
      cwd: null,
    },
    ...overrides,
  };
}

describe("parseServers", () => {
  it("reads a stored list back as it was saved", () => {
    const server = stdio({
      trusted: true,
      tools: { echo: "allow", add: "deny" },
      transport: {
        type: "stdio",
        command: "uvx",
        args: ["mcp-server-fetch"],
        env: [
          { name: "PLAIN", secret: false, value: "1" },
          { name: "TOKEN", secret: true },
        ],
        cwd: "/srv",
      },
    });
    expect(parseServers(JSON.parse(JSON.stringify([server])))).toEqual([
      server,
    ]);
  });

  it("never guesses at a damaged entry: it is dropped, not started", () => {
    const servers = parseServers([
      null,
      "x",
      { ...stdio(), id: "Not An Id" },
      { ...stdio(), name: "" },
      { ...stdio(), transport: { type: "stdio", command: "  " } },
      { ...stdio(), transport: { type: "http", url: "ftp://x" } },
      { ...stdio(), transport: { type: "websocket", url: "ws://x" } },
    ]);
    expect(servers).toEqual([]);
  });

  it("keeps the first of repeated ids and names", () => {
    const a = stdio();
    const b = { ...stdio(), name: "EVERYTHING", id: "other" };
    const c = { ...stdio(), name: "second" };
    expect(parseServers([a, b, c]).map((s) => s.name)).toEqual(["everything"]);
  });

  it("starts nothing and trusts nothing unless stored so", () => {
    const [server] = parseServers([
      { ...stdio(), enabled: "yes", trusted: 1, secretsRevision: "2" },
    ]);
    expect(server.enabled).toBe(false);
    expect(server.trusted).toBe(false);
    expect(server.secretsRevision).toBe(0);
  });

  it("drops invalid names and never keeps a value for a secret", () => {
    const [server] = parseServers([
      {
        ...stdio(),
        transport: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: [
            { name: "Authorization", secret: true, value: "leaked" },
            { name: "Host", secret: false, value: "evil" },
            { name: "Bad Name", secret: false, value: "x" },
            { name: "X-Team", secret: false, value: "a" },
            { name: "x-team", secret: false, value: "duplicate" },
          ],
        },
      },
    ]);
    expect(server.transport).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: [
        { name: "Authorization", secret: true },
        { name: "X-Team", secret: false, value: "a" },
      ],
    });
  });

  it("keeps where a server came from, for imports and projects", () => {
    const sources = parseServers([
      { ...stdio(), id: "a", name: "a", source: "imported:claude-desktop" },
      { ...stdio(), id: "b", name: "b", source: "project:/repo" },
      { ...stdio(), id: "c", name: "c", source: "anything else" },
    ]).map((s) => s.source);
    expect(sources).toEqual([
      "imported:claude-desktop",
      "project:/repo",
      "settings",
    ]);
  });
});

describe("launchKey", () => {
  it("changes with what the server is started with, not with trust or tool choices", () => {
    const base = stdio();
    const key = launchKey(base);
    expect(launchKey({ ...base, trusted: true })).toBe(key);
    expect(launchKey({ ...base, name: "renamed" })).toBe(key);
    expect(launchKey({ ...base, tools: { echo: "deny" } })).toBe(key);
    expect(launchKey({ ...base, secretsRevision: 1 })).not.toBe(key);
    expect(
      launchKey({
        ...base,
        transport: { ...base.transport, args: ["-y", "other"] } as never,
      }),
    ).not.toBe(key);
  });
});

describe("validateServer", () => {
  it("asks for a unique name, a command or URL, and absolute folders", () => {
    expect(validateServer(stdio(), [])).toEqual({});
    expect(validateServer(stdio({ name: " " }), []).name).toBeTruthy();
    expect(
      validateServer(stdio(), [stdio({ id: "other", name: "Everything" })])
        .name,
    ).toBe("Another server has this name.");
    expect(
      validateServer(
        stdio({
          transport: {
            type: "stdio",
            command: "x",
            args: [],
            env: [],
            cwd: "relative",
          },
        }),
        [],
      ).cwd,
    ).toBeTruthy();
    expect(
      validateServer(
        stdio({ transport: { type: "http", url: "nope", headers: [] } }),
        [],
      ).url,
    ).toBeTruthy();
  });

  it("refuses names a server cannot use and values listed twice", () => {
    const env = (names: string[]) =>
      stdio({
        transport: {
          type: "stdio",
          command: "x",
          args: [],
          env: names.map((name) => ({ name, secret: false, value: "" })),
          cwd: null,
        },
      });
    expect(validateServer(env(["A-B"]), []).values).toBeTruthy();
    expect(validateServer(env(["A", "A"]), []).values).toBeTruthy();
    expect(
      validateServer(
        stdio({
          transport: {
            type: "http",
            url: "https://x.test",
            headers: [{ name: "Cookie", secret: false, value: "x" }],
          },
        }),
        [],
      ).values,
    ).toBeTruthy();
  });
});

describe("helpers", () => {
  it("lists secret entries as keychain references", () => {
    expect(
      secretRefs({
        type: "stdio",
        command: "x",
        args: [],
        env: [
          { name: "A", secret: true },
          { name: "B", secret: false, value: "b" },
        ],
        cwd: null,
      }),
    ).toEqual([{ kind: "env", name: "A" }]);
    expect(
      secretRefs({
        type: "sse",
        url: "https://x.test",
        headers: [{ name: "Authorization", secret: true }],
      }),
    ).toEqual([{ kind: "header", name: "Authorization" }]);
  });

  it("splits plain values from secret names", () => {
    expect(
      splitValues([
        { name: "A", secret: false, value: "1" },
        { name: "B", secret: true },
      ]),
    ).toEqual({ plain: { A: "1" }, secret: ["B"] });
  });

  it("accepts only http URLs without credentials", () => {
    expect(isHttpUrl("https://mcp.example.com/mcp")).toBe(true);
    expect(isHttpUrl("http://localhost:3000/mcp")).toBe(true);
    expect(isHttpUrl("https://user:pw@example.com")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });

  it("knows the headers the backend owns", () => {
    expect(isValidHeaderName("X-Api-Key")).toBe(true);
    expect(isValidHeaderName("Content-Length")).toBe(false);
    expect(isValidHeaderName("host")).toBe(false);
  });

  it("recognizes absolute paths on every platform", () => {
    expect(isAbsolutePath("/srv/mcp")).toBe(true);
    expect(isAbsolutePath("C:\\tools")).toBe(true);
    expect(isAbsolutePath("\\\\server\\share")).toBe(true);
    expect(isAbsolutePath("tools")).toBe(false);
  });
});
