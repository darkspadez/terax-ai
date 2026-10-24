import { describe, expect, it } from "vitest";
import { plist, qualify } from "./run.ts";

const visible = {
  native: { appActive: true, key: true, occlusionVisible: true },
  visibility: "visible",
  gpu: { windowFocused: true },
};

describe("qualify", () => {
  const occlusion = {
    workload: "occlusion",
    occlusionMode: "orderout",
    expectReclaim: true,
  };

  it("accepts a visible, focused sample and never judges blank or done", () => {
    expect(
      qualify("cycle-1-visible", { ...visible, step: "visible" }, occlusion),
    ).toEqual([]);
    expect(qualify("blank", {}, occlusion)).toEqual([]);
  });

  it("requires an occluded hold that reclaimed", () => {
    expect(
      qualify(
        "cycle-1-hidden",
        {
          step: "hidden",
          hide: { ok: true, occluded: false, mode: "cover" },
          native: { occlusionVisible: true },
          visibility: "visible",
          reclaimedThisCycle: 0,
        },
        occlusion,
      ),
    ).toEqual([
      "window was not occluded by 'cover'",
      "AppKit still reports the window visible during the hold",
      "document.visibilityState=visible during the hold",
      "presentation policy did not publish reclaim during the hold",
    ]);
    expect(
      qualify(
        "cycle-1-hidden",
        {
          step: "hidden",
          hide: { ok: true, occluded: true },
          visibility: "hidden",
          reclaimedThisCycle: 1,
        },
        { ...occlusion, expectReclaim: false },
      ),
    ).toEqual([
      "presentation policy reclaimed during a control hold that must not reclaim",
    ]);
  });

  it("judges a control run's reclaim over the whole cycle", () => {
    expect(
      qualify(
        "cycle-1-visible",
        {
          ...visible,
          step: "visible",
          hiddenDiag: {},
          hide: { ok: true, occluded: true },
          reclaimedThisCycle: 1,
        },
        { ...occlusion, expectReclaim: false },
      ),
    ).toEqual([
      "presentation policy reclaimed during a control cycle that must not reclaim",
    ]);
  });

  it("rejects samples taken while the window was not usable", () => {
    expect(
      qualify(
        "measure-end",
        {
          native: {},
          visibility: "hidden",
          gpu: { windowFocused: false },
          surfaces: [{ visible: true, documentSuspended: true }],
          show: { ok: false },
        },
        { workload: "agents", occlusionMode: "orderout", expectReclaim: true },
      ),
    ).toEqual([
      "application is not active",
      "benchmark window is not key",
      "window is occluded",
      "document.visibilityState=hidden",
      "renderer reports the window unfocused",
      "a visible surface is suspended",
      "window did not return to visible+key after show",
    ]);
  });
});

describe("plist", () => {
  it("writes plistlib's XML with sorted keys and escaped strings", () => {
    expect(plist({ b: "x&y<z>", a: true })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "\t<key>a</key>",
        "\t<true/>",
        "\t<key>b</key>",
        "\t<string>x&amp;y&lt;z&gt;</string>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
  });
});
