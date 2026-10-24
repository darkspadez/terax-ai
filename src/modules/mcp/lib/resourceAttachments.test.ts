import { describe, expect, it } from "vitest";
import { MAX_TEXT_ATTACHMENT_BYTES } from "@/modules/ai/lib/pathAttachment";
import {
  MAX_IMAGE_SOURCE_BASE64,
  MAX_RESOURCE_PARTS,
  resourceAttachments,
} from "./resourceAttachments";

const request = { uri: "notes://today", name: "Today" };

describe("resourceAttachments", () => {
  it("attaches text with its type and byte size", () => {
    expect(
      resourceAttachments(
        {
          contents: [
            { uri: "notes://today", mimeType: "text/markdown", text: "héllo" },
          ],
        },
        request,
      ),
    ).toEqual({
      drafts: [
        {
          kind: "text",
          name: "Today",
          uri: "notes://today",
          mediaType: "text/markdown",
          text: "héllo",
          size: 6,
        },
      ],
      refused: [],
    });
  });

  it("refuses text over the attachment cap, as for a file", () => {
    const out = resourceAttachments(
      {
        contents: [
          {
            uri: "notes://today",
            text: "a".repeat(MAX_TEXT_ATTACHMENT_BYTES + 1),
          },
        ],
      },
      request,
    );
    expect(out.drafts).toEqual([]);
    expect(out.refused[0]).toMatch(
      /^Today: It is 201 KB; a text attachment holds up to 200 KB\.$/,
    );
  });

  it("attaches images and refuses other binary content with a reason", () => {
    const out = resourceAttachments(
      {
        contents: [
          { uri: "img://a.png", mimeType: "image/png", blob: "iVBORw0KGgo=" },
          { uri: "bin://b", mimeType: "application/zip", blob: "UEsDBA==" },
          { uri: "bin://c", blob: "AAAA" },
          { uri: "img://d", mimeType: "image/png", blob: "not base64!" },
          {
            uri: "img://e",
            mimeType: "image/png",
            blob: "A".repeat(MAX_IMAGE_SOURCE_BASE64 + 4),
          },
        ],
      },
      request,
    );
    expect(out.drafts).toEqual([
      {
        kind: "image",
        name: "a.png",
        uri: "img://a.png",
        mediaType: "image/png",
        data: "iVBORw0KGgo=",
        size: 8,
      },
    ]);
    expect(out.refused).toEqual([
      "b: binary content (application/zip) cannot be attached; a resource attaches as text or an image.",
      "c: binary content cannot be attached; a resource attaches as text or an image.",
      "d: the server sent a damaged image.",
      "e: the image is too large to attach.",
    ]);
  });

  it("names each part of a resource that has several, and caps them", () => {
    const contents = Array.from({ length: MAX_RESOURCE_PARTS + 2 }, (_, i) => ({
      uri: `dir://x/file${i}.txt`,
      text: String(i),
    }));
    const out = resourceAttachments(
      { contents },
      { uri: "dir://x", name: "x" },
    );
    expect(out.drafts).toHaveLength(MAX_RESOURCE_PARTS);
    expect(out.drafts[0].name).toBe("file0.txt");
    expect(out.refused).toEqual([
      `x: 2 more parts were left out (at most ${MAX_RESOURCE_PARTS} from one resource).`,
    ]);
  });

  it("says so when the server returned nothing", () => {
    expect(resourceAttachments({ contents: [] }, request)).toEqual({
      drafts: [],
      refused: ["Today: the server returned nothing."],
    });
    expect(resourceAttachments(null, request).refused).toHaveLength(1);
  });
});
