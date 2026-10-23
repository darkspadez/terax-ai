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
