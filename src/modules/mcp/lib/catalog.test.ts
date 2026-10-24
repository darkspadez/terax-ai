import { afterEach, describe, expect, it } from "vitest";
import { mcpCallTarget, useMcpCatalog } from "./catalog";

afterEach(() => useMcpCatalog.getState().setTools({}));

describe("mcpCallTarget", () => {
  it("names a live tool's server from the catalog", () => {
    useMcpCatalog.getState().setTools({
      mcp__gh__issue: {
        name: "mcp__gh__issue",
        serverId: "s1",
        serverName: "GitHub",
        tool: "create_issue",
        trusted: false,
      },
    });
    expect(mcpCallTarget("mcp__gh__issue", null)).toEqual({
      serverName: "GitHub",
      tool: "create_issue",
    });
  });

  it("falls back to what the call carries, for history", () => {
    expect(
      mcpCallTarget("mcp__old__x", {
        mcp: { serverId: "s9", server: "Old", tool: "x.y" },
      }),
    ).toEqual({ serverName: "Old", tool: "x.y" });
    expect(mcpCallTarget("mcp__old__x", { mcp: { server: 1 } })).toBe(null);
    expect(mcpCallTarget("mcp__old__x", undefined)).toBe(null);
  });
});
