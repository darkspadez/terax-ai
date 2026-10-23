import { describe, expect, it } from "vitest";
import {
  errorText,
  MAX_IMAGE_BASE64,
  MAX_RESULT_IMAGES,
  MAX_RESULT_TEXT,
  mcpToModelOutput,
  type McpToolOutput,
  toToolOutput,
} from "./results";

function output(result: unknown): McpToolOutput {
  const out = toToolOutput(result, "srv", "tool");
  if ("error" in out) throw new Error(out.error);
  return out.output;
}

describe("toToolOutput", () => {
  it("keeps text and allowed images", () => {
    expect(
      output({
        content: [
          { type: "text", text: "hello" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
          { type: "text", text: "world" },
        ],
      }),
    ).toEqual({
      kind: "mcp",
      server: "srv",
      tool: "tool",
      content: [
        { type: "text", text: "hello" },
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "text", text: "world" },
      ],
      notes: [],
    });
  });

  it("caps text and tells the model what was cut", () => {
    const out = output({
      content: [{ type: "text", text: "x".repeat(MAX_RESULT_TEXT + 100) }],
    });
    expect(out.content).toEqual([
      { type: "text", text: "x".repeat(MAX_RESULT_TEXT) },
    ]);
    expect(out.notes[0]).toMatch(/truncated.*50,100.*50,000/);
  });

  it("leaves out images it cannot pass on, saying so", () => {
    const big = "A".repeat(MAX_IMAGE_BASE64 + 1);
    const out = output({
      content: [
        { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
        { type: "image", mimeType: "image/png", data: big },
        ...Array.from({ length: MAX_RESULT_IMAGES + 1 }, () => ({
          type: "image",
          mimeType: "image/jpeg",
          data: "AAAA",
        })),
      ],
    });
    expect(out.content.filter((p) => p.type === "image")).toHaveLength(
      MAX_RESULT_IMAGES,
    );
    expect(out.notes).toHaveLength(3);
  });

  it("turns links, resources and audio into text or notes", () => {
    const out = output({
      content: [
        {
          type: "resource_link",
          uri: "file:///a.txt",
          name: "a.txt",
          mimeType: "text/plain",
        },
        {
          type: "resource",
          resource: { uri: "mem://notes", mimeType: "text/plain", text: "N" },
        },
        {
          type: "resource",
          resource: { uri: "mem://pic", mimeType: "image/png", blob: "AAAA" },
        },
        {
          type: "resource",
          resource: {
            uri: "mem://bin",
            mimeType: "application/zip",
            blob: "x",
          },
        },
        { type: "audio", mimeType: "audio/wav", data: "x" },
        { type: "hologram" },
      ],
    });
    expect(out.content).toEqual([
      {
        type: "text",
        text: "Resource link: a.txt <file:///a.txt> (text/plain)\nResource mem://notes:\nN",
      },
      { type: "image", mediaType: "image/png", data: "AAAA" },
    ]);
    expect(out.notes).toEqual([
      "A binary resource was left out: mem://bin (application/zip).",
      "Audio content was left out.",
      "Content of type hologram was left out.",
    ]);
  });

  it("shows structured content only when the server sent no text", () => {
    expect(
      output({ content: [], structuredContent: { a: 1 } }).content,
    ).toEqual([{ type: "text", text: '{\n  "a": 1\n}' }]);
    expect(
      output({
        content: [{ type: "text", text: "summary" }],
        structuredContent: { a: 1 },
      }).content,
    ).toEqual([{ type: "text", text: "summary" }]);
    expect(output({ content: [] }).content).toEqual([
      { type: "text", text: "(no output)" },
    ]);
  });

  it("makes a tool error the call's error", () => {
    expect(
      toToolOutput(
        { isError: true, content: [{ type: "text", text: "No such repo" }] },
        "srv",
        "tool",
      ),
    ).toEqual({ error: "No such repo" });
    expect(toToolOutput("garbage", "srv", "tool")).toEqual({
      error: "The server returned no result.",
    });
    expect(errorText(null, "x".repeat(10_000)).length).toBeLessThan(4100);
  });
});

describe("mcpToModelOutput", () => {
  it("gives text-only results as text, with the notes", () => {
    expect(
      mcpToModelOutput({
        kind: "mcp",
        server: "s",
        tool: "t",
        content: [{ type: "text", text: "hi" }],
        notes: ["Audio content was left out."],
      }),
    ).toEqual({
      type: "text",
      value: "hi\n[Audio content was left out.]",
    });
  });

  it("passes images on as files", () => {
    expect(
      mcpToModelOutput({
        kind: "mcp",
        server: "s",
        tool: "t",
        content: [
          { type: "text", text: "shot" },
          { type: "image", mediaType: "image/png", data: "AAAA" },
        ],
        notes: [],
      }),
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "shot" },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "AAAA" },
        },
      ],
    });
  });

  it("falls back to JSON for anything else", () => {
    expect(mcpToModelOutput({ a: 1 })).toEqual({
      type: "text",
      value: '{"a":1}',
    });
  });
});
