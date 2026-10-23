import { describe, expect, it } from "vitest";
import {
  exposedToolNames,
  isMcpToolName,
  MAX_TOOL_NAME_LENGTH,
  sanitizeNamePart,
  shortHash,
  toolKey,
} from "./toolNames";

const PROVIDER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

describe("exposedToolNames", () => {
  it("names a tool mcp__<server>__<tool>", () => {
    const names = exposedToolNames([
      { serverId: "s1", serverName: "github", tool: "create_issue" },
    ]);
    expect(names.get(toolKey("s1", "create_issue"))).toBe(
      "mcp__github__create_issue",
    );
  });

  it("makes every name one providers accept", () => {
    const names = exposedToolNames([
      {
        serverId: "s1",
        serverName: "My Server (prod)",
        tool: "files.read/all",
      },
      { serverId: "s2", serverName: "x".repeat(80), tool: "y".repeat(80) },
      { serverId: "s3", serverName: "日本", tool: "" },
    ]);
    for (const name of names.values()) {
      expect(name).toMatch(PROVIDER_NAME);
      expect(name.startsWith("mcp__")).toBe(true);
    }
    expect(names.get(toolKey("s1", "files.read/all"))).toBe(
      "mcp__My_Server__prod___files_read_all",
    );
  });

  it("caps long names with a hash of what they stand for", () => {
    const names = exposedToolNames([
      { serverId: "s1", serverName: "server", tool: "t".repeat(100) },
      { serverId: "s1", serverName: "server", tool: `${"t".repeat(99)}u` },
    ]);
    const [a, b] = [...names.values()];
    expect(a.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(b.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(a).not.toBe(b);
  });

  it("resolves collisions after sanitizing, keeping the first as is", () => {
    const names = exposedToolNames([
      { serverId: "s1", serverName: "a", tool: "x.y" },
      { serverId: "s1", serverName: "a", tool: "x_y" },
      { serverId: "s2", serverName: "a!", tool: "x_y" },
    ]);
    const values = [...names.values()];
    expect(values[0]).toBe("mcp__a__x_y");
    expect(new Set(values).size).toBe(3);
    for (const name of values) expect(name).toMatch(PROVIDER_NAME);
  });

  it("gives the same names for the same lists", () => {
    const entries = [
      { serverId: "s1", serverName: "a", tool: "x.y" },
      { serverId: "s1", serverName: "a", tool: "x_y" },
    ];
    expect([...exposedToolNames(entries)]).toEqual([
      ...exposedToolNames(entries),
    ]);
  });
});

describe("helpers", () => {
  it("tells MCP tools from Oarlock's own", () => {
    expect(isMcpToolName("mcp__github__x")).toBe(true);
    expect(isMcpToolName("bash_run")).toBe(false);
  });

  it("sanitizes a part, never to nothing", () => {
    expect(sanitizeNamePart("a b-c_d")).toBe("a_b-c_d");
    expect(sanitizeNamePart("")).toBe("_");
  });

  it("hashes stably to six characters", () => {
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc")).not.toBe(shortHash("abd"));
    expect(shortHash("abc")).toMatch(/^[0-9a-z]{6}$/);
  });
});
