import { describe, expect, it } from "vitest";
import type { McpServerExtras } from "./extrasCatalog";
import { mcpPickerSections } from "./pickerItems";

const server = (id: string, n: number): McpServerExtras => ({
  serverId: id,
  serverName: id.toUpperCase(),
  resources: Array.from({ length: n }, (_, i) => ({
    uri: `${id}://r${i}`,
    name: `res ${i}`,
  })),
  templates: [
    {
      uriTemplate: `${id}://user/{name}`,
      name: "User",
      title: "Find a user",
      variables: ["name"],
      optional: [],
    },
  ],
  prompts: [],
  completions: false,
});

describe("mcpPickerSections", () => {
  it("lists each server's matching resources, then templates", () => {
    const sections = mcpPickerSections([server("a", 2), server("b", 0)], "");
    expect(
      sections.map((s) => [
        s.serverName,
        s.items.map((i) => i.kind),
        s.truncated,
      ]),
    ).toEqual([
      ["A", ["resource", "resource", "template"], false],
      ["B", ["template"], false],
    ]);
  });

  it("filters by name, title and address, and caps each section", () => {
    expect(mcpPickerSections([server("a", 3)], "RES 1")[0].items).toHaveLength(
      1,
    );
    expect(mcpPickerSections([server("a", 3)], "find a")[0].items[0].kind).toBe(
      "template",
    );
    expect(mcpPickerSections([server("a", 3)], "a://r2")[0].items).toHaveLength(
      1,
    );
    expect(mcpPickerSections([server("a", 3)], "zzz")).toEqual([]);
    const capped = mcpPickerSections([server("a", 10)], "", 4)[0];
    expect(capped.items).toHaveLength(4);
    expect(capped.truncated).toBe(true);
  });
});
