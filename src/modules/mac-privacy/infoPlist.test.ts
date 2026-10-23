import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// macOS shows these sentences in its privacy prompts for Terax, which also
// stands for every program its terminals start.
const plist = readFileSync(
  fileURLToPath(new URL("../../../src-tauri/Info.plist", import.meta.url)),
  "utf8",
);

function plistString(key: string): string | undefined {
  return plist.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
  )?.[1];
}

describe("Info.plist privacy prompts", () => {
  it.each([
    ["NSDesktopFolderUsageDescription", "Desktop folder"],
    ["NSDocumentsFolderUsageDescription", "Documents folder"],
    ["NSDownloadsFolderUsageDescription", "Downloads folder"],
    ["NSRemovableVolumesUsageDescription", "removable volumes"],
    ["NSNetworkVolumesUsageDescription", "network volumes"],
    ["NSFileProviderDomainUsageDescription", "iCloud Drive"],
  ])("%s says what it is for", (key, place) => {
    const text = plistString(key);
    expect(text).toBeDefined();
    expect(text).toContain(place);
    expect(text).toMatch(/programs running in its terminals/);
    expect(text).toMatch(/\.$/);
  });
});
