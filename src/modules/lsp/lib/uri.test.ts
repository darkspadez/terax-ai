import { describe, expect, it } from "vitest";
import { fileUriToPath, pathToFileUri, sameFileUri } from "./uri";

describe("pathToFileUri", () => {
  it("encodes a unix path", () => {
    expect(pathToFileUri("/Users/me/src/app.ts")).toBe(
      "file:///Users/me/src/app.ts",
    );
  });

  it("encodes a windows path with drive letter", () => {
    expect(pathToFileUri("C:/Users/me/app.ts")).toBe(
      "file:///C:/Users/me/app.ts",
    );
    expect(pathToFileUri("C:\\Users\\me\\app.ts")).toBe(
      "file:///C:/Users/me/app.ts",
    );
  });

  it("percent-encodes special characters but not colon or plus", () => {
    expect(pathToFileUri("/a b/c#d/e%f/g+h.ts")).toBe(
      "file:///a%20b/c%23d/e%25f/g+h.ts",
    );
  });
});

describe("fileUriToPath", () => {
  it("roundtrips unix paths", () => {
    expect(fileUriToPath(pathToFileUri("/Users/me/a b/app.ts"))).toBe(
      "/Users/me/a b/app.ts",
    );
  });

  it("strips the leading slash on windows drive URIs", () => {
    expect(fileUriToPath("file:///C:/Users/me/app.ts")).toBe(
      "C:/Users/me/app.ts",
    );
  });

  it("rejects non-file uris", () => {
    expect(fileUriToPath("https://example.com/x")).toBeNull();
  });

  it("decodes an encoded, lower-case drive (crynta/terax-ai#1305)", () => {
    expect(fileUriToPath("file:///d%3A/repo/app.py")).toBe("D:/repo/app.py");
  });
});

describe("sameFileUri", () => {
  it("matches a server's spelling of our document URI", () => {
    const ours = pathToFileUri("D:\\repo\\src\\app.py");
    expect(sameFileUri("file:///d%3A/repo/src/app.py", ours)).toBe(true);
    expect(sameFileUri("file:///D:/repo/src/app.py", ours)).toBe(true);
  });

  it("tells different files apart", () => {
    expect(
      sameFileUri("file:///d%3A/repo/b.py", pathToFileUri("D:/repo/a.py")),
    ).toBe(false);
    expect(
      sameFileUri(pathToFileUri("/repo/A.ts"), pathToFileUri("/repo/a.ts")),
    ).toBe(false);
    expect(sameFileUri("untitled:1", "untitled:2")).toBe(false);
  });
});
