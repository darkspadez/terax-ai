import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UpdaterDialog } from "./UpdaterDialog";
import { GITHUB_LATEST_RELEASE, UPDATES_ENABLED } from "./useUpdater";

const read = (path: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../src-tauri/${path}`, import.meta.url),
      "utf8",
    ),
  );

describe("updates", () => {
  it("are off until Oarlock publishes its own releases", () => {
    expect(UPDATES_ENABLED).toBe(false);
    expect(UpdaterDialog()).toBeNull();
  });

  it("never point at upstream's releases, and need the feed, key, artifacts and permission together", () => {
    const config = read("tauri.conf.json");
    const endpoints: string[] = config.plugins.updater.endpoints ?? [];
    const permissions: string[] = read("capabilities/desktop.json").permissions;
    for (const endpoint of endpoints) {
      expect(endpoint).not.toContain("github.com/crynta/");
    }
    expect(GITHUB_LATEST_RELEASE).toBe(
      "https://api.github.com/repos/qopsc/oarlock/releases/latest",
    );
    expect(endpoints.length > 0).toBe(UPDATES_ENABLED);
    expect(config.plugins.updater.pubkey.length > 0).toBe(UPDATES_ENABLED);
    expect(config.bundle.createUpdaterArtifacts).toBe(UPDATES_ENABLED);
    expect(permissions.includes("updater:default")).toBe(UPDATES_ENABLED);
  });
});
