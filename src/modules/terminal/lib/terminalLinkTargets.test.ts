import { describe, expect, it } from "vitest";
import {
  isLocalFileHost,
  joinPath,
  resolveTerminalLink,
} from "./terminalLinkTargets";

describe("terminal link targets", () => {
  it("sends URLs with a scheme to the browser", () => {
    expect(resolveTerminalLink("https://oarlock.app", null, null)).toEqual({
      kind: "external",
      url: "https://oarlock.app",
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

describe("file:// hosts", () => {
  // crynta/terax-ai#831: `ls --hyperlink` and eza name this machine.
  it("treats this machine's name like localhost", () => {
    expect(isLocalFileHost("", null)).toBe(true);
    expect(isLocalFileHost("localhost", null)).toBe(true);
    expect(
      isLocalFileHost("users-macbook-pro.local", "Users-MacBook-Pro.local"),
    ).toBe(true);
    expect(isLocalFileHost("vm.", "vm")).toBe(true);
    expect(isLocalFileHost("build-server", "vm")).toBe(false);
    expect(isLocalFileHost("vm", null)).toBe(false);
    expect(
      resolveTerminalLink(
        "file://Users-MacBook-Pro.local/etc/hosts",
        null,
        null,
        "Users-MacBook-Pro.local",
      ),
    ).toEqual({ kind: "file", path: "/etc/hosts", line: null, column: null });
    expect(
      resolveTerminalLink(
        "file://DESKTOP-1/C:/x/y.rs",
        null,
        null,
        "DESKTOP-1",
      ),
    ).toMatchObject({ path: "C:/x/y.rs" });
  });
});
