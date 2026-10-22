import { describe, expect, it } from "vitest";
import { parentDir } from "./watch";

describe("parentDir", () => {
  it("returns the folder holding a path", () => {
    expect(parentDir("/home/u/a.ts")).toBe("/home/u");
    expect(parentDir("C:/Users/u/a.ts")).toBe("C:/Users/u");
    expect(parentDir("C:\\Users\\u\\a.ts")).toBe("C:\\Users\\u");
  });

  it("keeps the slash of a drive root, which `D:` alone would not mean", () => {
    expect(parentDir("D:/a.ts")).toBe("D:/");
    expect(parentDir("d:\\a.ts")).toBe("d:\\");
  });

  it("treats the filesystem root as its own parent", () => {
    expect(parentDir("/a.ts")).toBe("/");
    expect(parentDir("a.ts")).toBe("a.ts");
  });
});
