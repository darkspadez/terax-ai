import { describe, expect, it } from "vitest";
import { MAX_TEXT_ATTACHMENT_BYTES } from "@/modules/ai/lib/pathAttachment";
import { promptMessage } from "./promptMessages";
import { MAX_RESULT_IMAGES } from "./results";

describe("promptMessage", () => {
  it("sends a single user message as it is, in the prompt's block", () => {
    const out = promptMessage(
      { messages: [{ role: "user", content: { type: "text", text: "Hi" } }] },
      "Git",
      "greet",
    );
    expect(out).toEqual({
      block: expect.stringContaining('<mcp-prompt server="Git" name="greet">'),
      images: [],
      notes: [],
    });
    if ("block" in out) {
      expect(out.block).toMatch(/\n\nHi\n<\/mcp-prompt>$/);
      expect(out.block).not.toContain("[user]");
    }
  });

  it("labels roles when there are several messages, and keeps images and resources", () => {
    const out = promptMessage(
      {
        messages: [
          { role: "user", content: { type: "text", text: "Look" } },
          {
            role: "user",
            content: { type: "image", mimeType: "image/png", data: "AAAA" },
          },
          {
            role: "assistant",
            content: {
              type: "resource",
              resource: { uri: "doc://a", text: "Doc text" },
            },
          },
          {
            role: "user",
            content: [
              { type: "resource_link", uri: "doc://b", name: "B" },
              { type: "audio", mimeType: "audio/wav", data: "AAAA" },
              {
                type: "resource",
                resource: {
                  uri: "bin://c",
                  mimeType: "application/zip",
                  blob: "AA",
                },
              },
            ],
          },
        ],
      },
      "S",
      "p",
    );
    if (!("block" in out)) throw new Error(out.error);
    expect(out.block).toContain(
      "[user]\nLook\n\n[user]\n(Image 1 is attached to this message.)\n\n[assistant]\nResource doc://a:\nDoc text\n\n[user]\nResource link: B <doc://b>",
    );
    expect(out.images).toEqual([{ mediaType: "image/png", data: "AAAA" }]);
    expect(out.notes).toEqual([
      "Audio content was left out.",
      "The binary resource bin://c was left out.",
    ]);
  });

  it("caps images like a tool result", () => {
    const image = { type: "image", mimeType: "image/png", data: "AAAA" };
    const out = promptMessage(
      {
        messages: [
          { role: "user", content: Array(MAX_RESULT_IMAGES + 1).fill(image) },
        ],
      },
      "S",
      "p",
    );
    if (!("block" in out)) throw new Error(out.error);
    expect(out.images).toHaveLength(MAX_RESULT_IMAGES);
    expect(out.notes).toEqual(["An image was left out: over the size limit."]);
  });

  it("refuses a prompt over the text cap rather than cutting it", () => {
    const out = promptMessage(
      {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "a".repeat(MAX_TEXT_ATTACHMENT_BYTES + 1),
            },
          },
        ],
      },
      "S",
      "big",
    );
    expect(out).toEqual({
      error:
        "The prompt big is 201 KB of text; a prompt can bring up to 200 KB.",
    });
  });

  it("refuses a prompt with nothing to send", () => {
    expect(promptMessage({ messages: [] }, "S", "empty")).toEqual({
      error: "The prompt empty returned no messages Oarlock can send.",
    });
  });
});
