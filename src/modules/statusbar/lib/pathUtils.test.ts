import { describe, expect, it } from "vitest";
import { inSeparatorsOf, pathInside, segmentsFromCwd } from "./pathUtils";

function shape(cwd: string, home: string | null) {
  return segmentsFromCwd(cwd, home).map((s) => ({
    label: s.label,
    fullPath: s.fullPath,
    isHome: s.isHome,
  }));
}

describe("segmentsFromCwd", () => {
  it("renders a path under home with a ~ root and accumulated paths", () => {
    expect(shape("/Users/me/projects/oarlock", "/Users/me")).toEqual([
      { label: "~", fullPath: "/Users/me", isHome: true },
      { label: "projects", fullPath: "/Users/me/projects", isHome: false },
      { label: "oarlock", fullPath: "/Users/me/projects/oarlock", isHome: false },
    ]);
  });

  it("collapses the home directory itself to a single ~ segment", () => {
    expect(shape("/Users/me", "/Users/me")).toEqual([
      { label: "~", fullPath: "/Users/me", isHome: true },
    ]);
  });

  it("does not treat a sibling that merely shares the home prefix as home", () => {
    const segments = shape("/Users/mefoo", "/Users/me");
    expect(segments[0]).toEqual({ label: "/", fullPath: "/", isHome: false });
    expect(segments.map((s) => s.label)).toEqual(["/", "Users", "mefoo"]);
  });

  it("builds unix absolute paths from the / root", () => {
    expect(shape("/usr/local/bin", null)).toEqual([
      { label: "/", fullPath: "/", isHome: false },
      { label: "usr", fullPath: "/usr", isHome: false },
      { label: "local", fullPath: "/usr/local", isHome: false },
      { label: "bin", fullPath: "/usr/local/bin", isHome: false },
    ]);
  });

  it("uses the drive letter as the root on Windows paths", () => {
    expect(shape("C:/Users/me/proj", null)).toEqual([
      { label: "C:", fullPath: "C:/", isHome: false },
      { label: "Users", fullPath: "C:/Users", isHome: false },
      { label: "me", fullPath: "C:/Users/me", isHome: false },
      { label: "proj", fullPath: "C:/Users/me/proj", isHome: false },
    ]);
  });

  it("normalizes backslash separators", () => {
    expect(shape("C:\\Users\\me\\proj", null).map((s) => s.label)).toEqual([
      "C:",
      "Users",
      "me",
      "proj",
    ]);
  });

  it("returns just the root for a bare drive or /", () => {
    expect(shape("C:/", null)).toEqual([
      { label: "C:", fullPath: "C:/", isHome: false },
    ]);
    expect(shape("/", null)).toEqual([
      { label: "/", fullPath: "/", isHome: false },
    ]);
  });
});

describe("inSeparatorsOf", () => {
  it("gives a segment back the backslashes of a Windows path", () => {
    expect(inSeparatorsOf("C:/Users/me", "C:\\Users\\me\\proj")).toBe(
      "C:\\Users\\me",
    );
    expect(inSeparatorsOf("C:/", "C:\\Users")).toBe("C:\\");
  });

  it("keeps forward slashes for POSIX and mixed paths", () => {
    expect(inSeparatorsOf("/home/me", "/home/me/proj")).toBe("/home/me");
    expect(inSeparatorsOf("C:/a", "C:/a\\b")).toBe("C:/a");
  });
});

describe("pathInside", () => {
  it("is the path below the root", () => {
    expect(pathInside("/repo", "/repo/src/main.ts")).toBe("src/main.ts");
    expect(pathInside("/repo/", "/repo/src/")).toBe("src");
    expect(pathInside("C:\\repo", "C:\\repo\\src\\a.ts")).toBe("src/a.ts");
    expect(pathInside("/", "/etc/hosts")).toBe("etc/hosts");
  });

  it("is null for the root itself, a path outside it or no root", () => {
    expect(pathInside("/repo", "/repo")).toBeNull();
    expect(pathInside("/repo", "/repository/a")).toBeNull();
    expect(pathInside("/repo/src", "/repo")).toBeNull();
    expect(pathInside(null, "/repo/a")).toBeNull();
    expect(pathInside("", "/repo/a")).toBeNull();
  });
});
