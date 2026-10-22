import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UpdaterDialog } from "./UpdaterDialog";
import { UPDATES_ENABLED } from "./useUpdater";

const read = (path: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../src-tauri/${path}`, import.meta.url),
      "utf8",
    ),
  );

describe("updates", () => {
  it("are off until this fork publishes its own releases", () => {
    expect(UPDATES_ENABLED).toBe(false);
    expect(UpdaterDialog()).toBeNull();
  });

  it("never point at upstream's releases, and need the feed and permission together", () => {
    const endpoints: string[] =
      read("tauri.conf.json").plugins.updater.endpoints ?? [];
    const permissions: string[] = read("capabilities/desktop.json").permissions;
    for (const endpoint of endpoints) {
      expect(endpoint).not.toContain("github.com/crynta/");
    }
    expect(endpoints.length > 0).toBe(UPDATES_ENABLED);
    expect(permissions.includes("updater:default")).toBe(UPDATES_ENABLED);
  });
});
