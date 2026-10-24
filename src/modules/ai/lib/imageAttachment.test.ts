import { describe, expect, it } from "vitest";
import {
  fitWithin,
  imageNeedsEncoding,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  messageImages,
  nameForType,
} from "./imageAttachment";

// crynta/terax-ai#274: a pasted or picked image reaches every provider.
describe("imageNeedsEncoding", () => {
  it("sends the types every provider takes as they are", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(imageNeedsEncoding(type, 1000)).toBe(false);
    }
    expect(imageNeedsEncoding("IMAGE/PNG", 1000)).toBe(false);
  });

  it("encodes other types and images over Anthropic's 5 MiB of base64", () => {
    for (const type of [
      "image/tiff",
      "image/bmp",
      "image/heic",
      "image/svg+xml",
    ]) {
      expect(imageNeedsEncoding(type, 1000)).toBe(true);
    }
    expect(MAX_IMAGE_BYTES * (4 / 3)).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(imageNeedsEncoding("image/png", MAX_IMAGE_BYTES)).toBe(false);
    expect(imageNeedsEncoding("image/png", MAX_IMAGE_BYTES + 1)).toBe(true);
  });
});

describe("fitWithin", () => {
  it("scales the longer side down to the limit, keeping the shape", () => {
    expect(fitWithin(3456, 2234)).toEqual({
      width: MAX_IMAGE_SIDE,
      height: 1324,
    });
    expect(fitWithin(1000, 4096)).toEqual({ width: 500, height: 2048 });
  });

  it("never scales up and never reaches zero", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 1)).toEqual({ width: 2048, height: 1 });
    expect(fitWithin(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

describe("nameForType", () => {
  it("gives the file the extension of what it now is", () => {
    expect(nameForType("shot.heic", "image/png")).toBe("shot.png");
    expect(nameForType("photo.tiff", "image/jpeg")).toBe("photo.jpg");
    expect(nameForType("archive.tar.bmp", "image/png")).toBe("archive.tar.png");
    expect(nameForType("", "image/png")).toBe("image.png");
    expect(nameForType(".hidden", "image/png")).toBe(".hidden.png");
  });
});

describe("messageImages", () => {
  it("shows the inline images a message carries", () => {
    expect(
      messageImages([
        { type: "text" },
        {
          type: "file",
          mediaType: "image/png",
          url: "data:image/png;base64,AAAA",
          filename: "image.png",
        },
        {
          type: "file",
          mediaType: "image/jpeg",
          url: "data:image/jpeg;base64,BB",
        },
      ]),
    ).toEqual([
      { key: "part-1", url: "data:image/png;base64,AAAA", name: "image.png" },
      { key: "part-2", url: "data:image/jpeg;base64,BB", name: "Image" },
    ]);
  });

  it("never a URL a stored conversation names", () => {
    expect(
      messageImages([
        {
          type: "file",
          mediaType: "image/png",
          url: "https://example.com/x.png",
        },
        { type: "file", mediaType: "text/plain", url: "data:text/plain,hi" },
        { type: "file", url: 42 },
      ]),
    ).toEqual([]);
  });
});
