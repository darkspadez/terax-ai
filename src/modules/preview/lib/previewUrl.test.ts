import { describe, expect, it } from "vitest";
import { loopbackPreviewOrigin, terminalLinkPreviewTarget } from "./previewUrl";

describe("loopbackPreviewOrigin", () => {
  it.each([
    ["http://localhost:5173/login", "http://localhost:5173"],
    ["https://app.localhost/auth", "https://app.localhost"],
    ["http://localhost.:3000", "http://localhost.:3000"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://127.0.0.42:8080", "http://127.0.0.42:8080"],
    ["http://127.1:8080", "http://127.0.0.1:8080"],
    ["http://0.0.0.0:4173", "http://0.0.0.0:4173"],
    ["http://[::1]:3000", "http://[::1]:3000"],
  ])("returns the origin for %s", (url, origin) => {
    expect(loopbackPreviewOrigin(url)).toBe(origin);
  });

  it.each([
    "https://example.com",
    "http://192.168.1.10:3000",
    "ftp://localhost/file",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("rejects non-loopback or unusable URL %s", (url) => {
    expect(loopbackPreviewOrigin(url)).toBeNull();
  });
});

describe("terminalLinkPreviewTarget", () => {
  const tabs = [
    { id: 4, kind: "preview", spaceId: "a", url: "http://localhost:5173/" },
    { id: 5, kind: "preview", spaceId: "b", url: "http://localhost:3000/" },
  ];

  it("leaves links to the browser while the setting is off", () => {
    expect(
      terminalLinkPreviewTarget("http://localhost:5173/", false, tabs, "a"),
    ).toBeNull();
  });

  it("only previews local dev servers", () => {
    expect(
      terminalLinkPreviewTarget("https://example.com/", true, tabs, "a"),
    ).toBeNull();
  });

  it("reuses the space's preview of the same page, or asks for a new one", () => {
    expect(
      terminalLinkPreviewTarget("http://localhost:5173/", true, tabs, "a"),
    ).toBe(4);
    expect(
      terminalLinkPreviewTarget("http://localhost:3000/", true, tabs, "a"),
    ).toBe(0);
    expect(
      terminalLinkPreviewTarget("http://127.0.0.1:8000/", true, tabs, "a"),
    ).toBe(0);
  });
});
