import { describe, expect, it } from "vitest";
import { decimal, parseNerdFontTables, renderConstraints } from "./build.ts";

// The shape of Ghostty's generated nerd_font_tables.zig, cut down to one
// stage2 page (code points 0x100-0x1FF) and two constraints.
const ZIG = `pub fn Tables(comptime Elem: type) type {
    return struct {
        pub const stage1: [3]u16 = .{ 0, 256, 0 };

        pub const stage2: [512]u16 = .{ ${[
          ...Array(256).fill(0),
          1,
          1,
          2,
          ...Array(253).fill(0),
        ].join(", ")} };

        pub const stage3: [3]Elem = .{
            null,
            .{
                .size = .fit_cover1,
                .height = .icon,
                .align_horizontal = .center1,
                .align_vertical = .center1,
            },
            .{
                .size = .stretch,
                .max_constraint_width = 1,
                .align_horizontal = .start,
                .pad_top = -0.005,
                .relative_width = 0.71428571,
                .max_xy_ratio = 0.7,
            },
        };
    };
}
`;

describe("nerd font constraint tables", () => {
  it("reads the three-stage lookup into runs of code points", () => {
    const tables = parseNerdFontTables(ZIG);
    expect(tables.constraints[0]).toBeNull();
    expect(tables.constraints[2]).toMatchObject({
      size: ".stretch",
      max_constraint_width: "1",
      pad_top: "-0.005",
    });
    expect(tables.runs).toEqual([
      [0x100, 0x101, 1],
      [0x102, 0x102, 2],
    ]);
  });

  it("renders rules, rounded variants and delta-coded runs", () => {
    const module = renderConstraints(parseNerdFontTables(ZIG));
    expect(module).toContain(
      '["fitCover1", "icon", 2, "center1", "center1", 0, 0, 0, 0, 0],',
    );
    expect(module).toContain(
      '["stretch", "cell", 1, "start", "none", -0.005, 0, 0, 0, 0.7],',
    );
    expect(module).toContain("0, 1, 1, 0, 0, 1, 0.7143, 1, 0, 0,");
    // 256 code points skipped before 0x100, a run of two, then one more.
    expect(module).toContain("256, 1, 0, 0, 0, 1,");
    expect(module).toContain("if (codepoint < 0x100) return null;");
  });

  it("rounds to four decimals and steps clear of Math constants", () => {
    expect(decimal("0.71428571")).toBe("0.7143");
    expect(decimal("1.0")).toBe("1");
    expect(decimal("-0.00001")).toBe("0");
    expect(decimal("0.05", 6)).toBe("0.05");
    // 0.7071 reads as a sloppy Math.SQRT1_2 to Biome.
    expect(decimal("0.70710678")).toBe("0.70711");
  });
});
