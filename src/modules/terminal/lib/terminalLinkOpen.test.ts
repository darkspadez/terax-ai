import { describe, expect, it } from "vitest";
import {
  joinPath,
  openTerminalPreview,
  resolveTerminalLink,
  setTerminalPreviewOpener,
} from "./terminalLinkOpen";

describe("terminal link targets", () => {
  it("sends URLs with a scheme to the browser", () => {
    expect(resolveTerminalLink("https://terax.app", null, null)).toEqual({
      kind: "external",
      url: "https://terax.app",
    });
  });

  it("opens local file:// links, with a #L position", () => {
    expect(
      resolveTerminalLink("file:///Users/me/a%20b.ts#L12", null, null),
    ).toEqual({
      kind: "file",
      path: "/Users/me/a b.ts",
      line: 12,
      column: null,
    });
    expect(
      resolveTerminalLink("file://localhost/C:/x/y.rs", null, null),
    ).toMatchObject({
      path: "C:/x/y.rs",
    });
    expect(
      resolveTerminalLink("file://other-host/etc/passwd", null, null),
    ).toBeNull();
  });

  it("resolves paths against the working directory and home", () => {
    expect(
      resolveTerminalLink("src/main.rs:42:7", "/repo", "/home/me"),
    ).toEqual({
      kind: "file",
      path: "/repo/src/main.rs",
      line: 42,
      column: 7,
    });
    expect(
      resolveTerminalLink("../lib/a.ts(3,1)", "/repo/app", null),
    ).toMatchObject({
      path: "/repo/lib/a.ts",
      line: 3,
    });
    expect(resolveTerminalLink("~/notes.md", null, "/home/me")).toMatchObject({
      path: "/home/me/notes.md",
    });
    expect(
      resolveTerminalLink("C:\\proj\\a.cs(3,9)", null, null),
    ).toMatchObject({
      path: "C:\\proj\\a.cs",
      line: 3,
      column: 9,
    });
    expect(resolveTerminalLink("src/a.ts", null, null)).toBeNull();
    expect(resolveTerminalLink("~/a", null, null)).toBeNull();
  });

  it("joins paths with the base's separator", () => {
    expect(joinPath("/a/b", "../c/./d")).toBe("/a/c/d");
    expect(joinPath("C:\\work", "src\\x.cs")).toBe("C:\\work\\src\\x.cs");
    expect(joinPath("/", "etc")).toBe("/etc");
  });
});

describe("terminal link preview routing", () => {
  it("sends links to the browser unless the app takes them", () => {
    expect(openTerminalPreview("http://localhost:5173")).toBe(false);
    const seen: string[] = [];
    setTerminalPreviewOpener((url) => {
      seen.push(url);
      return url.includes("localhost");
    });
    expect(openTerminalPreview("http://localhost:5173")).toBe(true);
    expect(openTerminalPreview("https://terax.app")).toBe(false);
    setTerminalPreviewOpener(null);
    expect(openTerminalPreview("http://localhost:5173")).toBe(false);
    expect(seen).toEqual(["http://localhost:5173", "https://terax.app"]);
  });
});
