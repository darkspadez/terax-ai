import { describe, expect, it } from "vitest";
import { resolveSidebarPosition, sidebarPanelId } from "./sidebarPosition";

describe("resolveSidebarPosition", () => {
  it("lays out on the window's last side until preferences load", () => {
    expect(resolveSidebarPosition(false, "left", "right")).toBe("right");
    expect(resolveSidebarPosition(false, "right", "left")).toBe("left");
  });

  it("follows the stored preference once loaded, left for anything unknown", () => {
    expect(resolveSidebarPosition(true, "right", "left")).toBe("right");
    expect(resolveSidebarPosition(true, "left", "right")).toBe("left");
    expect(resolveSidebarPosition(true, "middle", "right")).toBe("left");
  });
});

describe("sidebarPanelId", () => {
  it("differs per side, so the panel registers again when it changes sides", () => {
    expect(sidebarPanelId("left")).not.toBe(sidebarPanelId("right"));
    expect(sidebarPanelId("left")).not.toBe("workspace");
    expect(sidebarPanelId("right")).not.toBe("workspace");
  });
});
