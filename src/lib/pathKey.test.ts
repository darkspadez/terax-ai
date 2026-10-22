import { describe, expect, it } from "vitest";
import { pathKey } from "./pathKey";

describe("pathKey", () => {
  it("unifies separators and the drive letter's case", () => {
    expect(pathKey("C:\\repo\\src\\a.ts")).toBe("C:/repo/src/a.ts");
    expect(pathKey("d:/repo/a.ts")).toBe("D:/repo/a.ts");
    expect(pathKey("/home/me/a.ts")).toBe("/home/me/a.ts");
  });

  it("drops a trailing separator but keeps roots", () => {
    expect(pathKey("/repo/dir/")).toBe("/repo/dir");
    expect(pathKey("C:\\repo\\dir\\")).toBe("C:/repo/dir");
    expect(pathKey("/")).toBe("/");
    expect(pathKey("c:\\")).toBe("C:/");
  });

  it("keeps the rest of the path's case", () => {
    expect(pathKey("C:/Repo/A.ts")).not.toBe(pathKey("C:/repo/a.ts"));
  });
});
