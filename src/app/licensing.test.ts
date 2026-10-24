import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Oarlock is Apache-2.0, a modified version of Terax: LICENSE and NOTICE ship
// in every bundle, and NOTICE points at every third-party notice that ships.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");

const PUBLISHER = "Quantum Ops Consulting, LLC";
const REPOSITORY = "https://github.com/qopsc/oarlock";

const config = JSON.parse(read("src-tauri/tauri.conf.json")) as {
  bundle: {
    resources: Record<string, string>;
    license: string;
    licenseFile: string;
    copyright: string;
    publisher: string;
  };
};
const notice = read("NOTICE");

/** The third-party notices the bundle ships, from their source path. */
const thirdParty = Object.entries(config.bundle.resources).filter(
  ([source]) => source !== "../LICENSE" && source !== "../NOTICE",
);

describe("licensing", () => {
  it("ships LICENSE and NOTICE in every bundle and shows the license in installers", () => {
    expect(config.bundle.resources["../LICENSE"]).toBe("LICENSE");
    expect(config.bundle.resources["../NOTICE"]).toBe("NOTICE");
    expect(config.bundle.license).toBe("Apache-2.0");
    expect(config.bundle.licenseFile).toBe("../LICENSE");
    expect(read("LICENSE")).toContain("Apache License\n");
  });

  it("names the publisher in the bundle and the package metadata", () => {
    expect(config.bundle.publisher).toBe(PUBLISHER);
    expect(config.bundle.copyright).toBe(`Copyright 2026 ${PUBLISHER}`);
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.author).toBe(PUBLISHER);
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.repository.url).toBe(`git+${REPOSITORY}.git`);
    const cargo = read("src-tauri/Cargo.toml");
    expect(cargo).toContain(`authors = ["${PUBLISHER}"]`);
    expect(cargo).toContain(`repository = "${REPOSITORY}"`);
  });

  it("credits Terax in NOTICE as the work Oarlock modifies", () => {
    expect(notice.startsWith(`Oarlock\nCopyright 2026 ${PUBLISHER}\n`)).toBe(
      true,
    );
    expect(notice).toContain(
      "Oarlock is a modified version of Terax (https://github.com/crynta/terax-ai),\nCopyright 2026 Crynta, licensed under the Apache License, Version 2.0.",
    );
  });

  it("points NOTICE at every third-party notice the bundle ships", () => {
    expect(thirdParty.length).toBeGreaterThan(0);
    for (const [source, bundled] of thirdParty) {
      const path = source.replace(/^\.\.\//, "");
      expect(existsSync(`${ROOT}${path}`), path).toBe(true);
      expect(notice, path).toContain(path);
      expect(notice, bundled).toContain(`(${bundled})`);
    }
  });
});
