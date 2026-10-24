import { describe, expect, it } from "vitest";
import {
  annotationLabels,
  cleanAnnotations,
  inputSchemaFor,
  isCallable,
  MAX_DESCRIPTION_LENGTH,
  MAX_SCHEMA_BYTES,
  type McpListedTool,
  toolDescription,
} from "./toolSchema";

function tool(overrides: Partial<McpListedTool> = {}): McpListedTool {
  return { name: "echo", inputSchema: { type: "object" }, ...overrides };
}

describe("toolDescription", () => {
  it("leads with the title and caps the length", () => {
    expect(
      toolDescription(tool({ title: "Echo", description: "Says it back." })),
    ).toBe("Echo: Says it back.");
    expect(toolDescription(tool({ description: "Echo back" }))).toBe(
      "Echo back",
    );
    expect(toolDescription(tool())).toBe("echo");
    const long = toolDescription(tool({ description: "x".repeat(10_000) }));
    expect(long.length).toBe(MAX_DESCRIPTION_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("inputSchemaFor", () => {
  it("offers the server's schema as an object schema", () => {
    expect(
      inputSchemaFor(
        tool({
          inputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        }),
      ),
    ).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
    expect(inputSchemaFor(tool({ inputSchema: {} }))).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("refuses what it cannot offer", () => {
    expect(inputSchemaFor(tool({ inputSchema: { type: "string" } }))).toBe(
      null,
    );
    expect(
      inputSchemaFor(tool({ inputSchema: null as unknown as object } as never)),
    ).toBe(null);
    expect(
      inputSchemaFor(
        tool({
          inputSchema: {
            type: "object",
            description: "x".repeat(MAX_SCHEMA_BYTES),
          },
        }),
      ),
    ).toBe(null);
  });
});

describe("annotations", () => {
  it("keeps only the known hints, typed", () => {
    expect(
      cleanAnnotations({
        readOnlyHint: true,
        destructiveHint: "yes",
        title: "T",
        extra: 1,
      }),
    ).toEqual({ readOnlyHint: true, title: "T" });
    expect(cleanAnnotations("x")).toBeUndefined();
    expect(cleanAnnotations({})).toBeUndefined();
  });

  it("words them as the server's claims", () => {
    expect(
      annotationLabels({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      }),
    ).toEqual(["Read-only", "Idempotent", "Reaches outside services"]);
    expect(annotationLabels({ destructiveHint: false })).toEqual([
      "Not destructive",
    ]);
    expect(annotationLabels(undefined)).toEqual([]);
  });
});

describe("isCallable", () => {
  it("leaves out tools that need task-based execution", () => {
    expect(isCallable(tool())).toBe(true);
    expect(isCallable(tool({ execution: { taskSupport: "optional" } }))).toBe(
      true,
    );
    expect(isCallable(tool({ execution: { taskSupport: "required" } }))).toBe(
      false,
    );
  });
});
