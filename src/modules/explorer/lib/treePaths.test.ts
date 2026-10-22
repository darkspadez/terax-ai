import { describe, expect, it } from "vitest";
import { dirname } from "./treePaths";

describe("dirname", () => {
  it("returns the folder holding a tree path", () => {
    expect(dirname("/home/u/src/a.ts")).toBe("/home/u/src");
    expect(dirname("C:/Users/u/a.ts")).toBe("C:/Users/u");
    expect(dirname("/a.ts")).toBe("/");
  });

  it("keeps the slash of a drive root so the root's listing is found", () => {
    expect(dirname("D:/a.ts")).toBe("D:/");
    expect(dirname("d:/folder")).toBe("d:/");
  });
});
