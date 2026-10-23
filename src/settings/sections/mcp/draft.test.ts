import type { McpServerConfig } from "@/modules/mcp/lib/config";
import { describe, expect, it } from "vitest";
import {
  draftErrors,
  draftFromServer,
  emptyDraft,
  hasErrors,
  newRow,
  secretChanges,
  serverFromDraft,
} from "./draft";

const server: McpServerConfig = {
  id: "s1",
  name: "github",
  source: "settings",
  enabled: false,
  trusted: true,
  tools: { delete_repo: "deny" },
  secretsRevision: 3,
  transport: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github", "--dir", "a b"],
    env: [
      { name: "GITHUB_TOKEN", secret: true },
      { name: "LOG", secret: false, value: "debug" },
    ],
    cwd: "/srv",
  },
};

describe("draft", () => {
  it("edits a server and saves it back unchanged", () => {
    const draft = draftFromServer(server, new Set(["env:GITHUB_TOKEN"]));
    expect(draft.commandLine).toBe(
      "npx -y @modelcontextprotocol/server-github --dir 'a b'",
    );
    expect(draft.env.map((r) => [r.name, r.secret, r.saved, r.value])).toEqual([
      ["GITHUB_TOKEN", true, true, ""],
      ["LOG", false, false, "debug"],
    ]);
    expect(serverFromDraft(draft)).toEqual(server);
    expect(secretChanges(draft)).toEqual({ set: [], remove: [] });
    expect(hasErrors(draftErrors(draft, [server]))).toBe(false);
  });

  it("starts a new server enabled, untrusted, from Settings", () => {
    const draft = {
      ...emptyDraft(),
      name: "fetch",
      commandLine: "uvx mcp-server-fetch",
    };
    expect(serverFromDraft(draft)).toMatchObject({
      name: "fetch",
      source: "settings",
      enabled: true,
      trusted: false,
      tools: {},
      transport: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
    });
  });

  it("writes typed secret values and deletes the ones the server no longer has", () => {
    const draft = draftFromServer(server, new Set(["env:GITHUB_TOKEN"]));
    draft.env = [
      { ...draft.env[0], secret: false, saved: false, value: "plain now" },
      draft.env[1],
      newRow({ name: "NEW_KEY", secret: true, value: "s3cret" }),
    ];
    expect(secretChanges(draft)).toEqual({
      set: [{ kind: "env", name: "NEW_KEY", value: "s3cret" }],
      remove: [{ kind: "env", name: "GITHUB_TOKEN" }],
    });
  });

  it("deletes every secret when the other transport is chosen", () => {
    const draft = draftFromServer(server, new Set());
    draft.type = "http";
    draft.url = "https://api.example.com/mcp";
    draft.headers = [
      newRow({ name: "Authorization", secret: true, value: "Bearer x" }),
    ];
    expect(secretChanges(draft)).toEqual({
      set: [{ kind: "header", name: "Authorization", value: "Bearer x" }],
      remove: [{ kind: "env", name: "GITHUB_TOKEN" }],
    });
    expect(serverFromDraft(draft).transport).toEqual({
      type: "http",
      url: "https://api.example.com/mcp",
      headers: [{ name: "Authorization", secret: true }],
    });
  });

  it("asks for a secret's value unless the keychain has it", () => {
    const unsaved = draftFromServer(server, new Set());
    expect(draftErrors(unsaved, []).secrets).toBe(
      "Enter the secret value of GITHUB_TOKEN.",
    );
    const saved = draftFromServer(server, new Set(["env:GITHUB_TOKEN"]));
    expect(draftErrors(saved, []).secrets).toBeUndefined();
  });

  it("refuses an empty command, unnamed values and taken names", () => {
    const draft = { ...emptyDraft(), name: "github", commandLine: "  " };
    draft.env = [newRow({ value: "orphan" })];
    const errors = draftErrors(draft, [server]);
    expect(errors.command).toBeTruthy();
    expect(errors.values).toBe("Give every value a name.");
    expect(errors.name).toBe("Another server has this name.");
  });

  it("drops rows left without a name or value", () => {
    const draft = { ...emptyDraft(), name: "x", commandLine: "x" };
    draft.env = [newRow()];
    expect(serverFromDraft(draft).transport).toMatchObject({ env: [] });
    expect(hasErrors(draftErrors(draft, []))).toBe(false);
  });
});

describe("sign-in client", () => {
  const remote: McpServerConfig = {
    ...server,
    transport: {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: [],
      oauth: {
        clientId: "my-app",
        clientSecret: true,
        scopes: "read",
        callbackPort: 8080,
      },
    },
  };

  it("edits a configured client and saves it back unchanged", () => {
    const draft = draftFromServer(remote, new Set(["oauth:client-secret"]));
    expect(draft.oauthClientId).toBe("my-app");
    expect(draft.oauthSecretSaved).toBe(true);
    expect(draft.oauthPort).toBe("8080");
    expect(serverFromDraft(draft)).toEqual(remote);
    expect(secretChanges(draft)).toEqual({ set: [], remove: [] });
    expect(hasErrors(draftErrors(draft, []))).toBe(false);
  });

  it("writes a new client secret to the keychain, and deletes it with the client", () => {
    const draft = {
      ...draftFromServer(remote, new Set()),
      oauthSecret: "shh",
    };
    expect(secretChanges(draft).set).toEqual([
      { kind: "oauth", name: "client-secret", value: "shh" },
    ]);
    const cleared = {
      ...draftFromServer(remote, new Set(["oauth:client-secret"])),
      oauthClientId: "",
      oauthScopes: "",
      oauthPort: "",
      oauthSecretSaved: false,
    };
    expect(serverFromDraft(cleared).transport).not.toHaveProperty("oauth");
    expect(secretChanges(cleared).remove).toEqual([
      { kind: "oauth", name: "client-secret" },
    ]);
  });

  it("asks for a client id behind any other client field, and a real port", () => {
    const base = { ...emptyDraft(), name: "r", type: "http" as const };
    const draft = { ...base, url: "https://x.example/mcp" };
    expect(
      draftErrors({ ...draft, oauthScopes: "read" }, []).oauth,
    ).toBeTruthy();
    expect(
      draftErrors({ ...draft, oauthClientId: "c", oauthPort: "70000" }, [])
        .oauth,
    ).toBeTruthy();
    expect(
      draftErrors({ ...draft, oauthClientId: "c", oauthPort: "8080" }, [])
        .oauth,
    ).toBeUndefined();
  });
});
