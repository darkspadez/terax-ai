import { describe, expect, it } from "vitest";
import { areaStatus, PRIVACY_AREAS, settingsPaneFor } from "./areas";

const FOLDERS = PRIVACY_AREAS.filter((area) => area !== "fullDiskAccess");

describe("areaStatus", () => {
  it("is checking until Full Disk Access is known", () => {
    for (const area of PRIVACY_AREAS) {
      expect(areaStatus(area, null)).toBe("checking");
    }
  });

  it("reports Full Disk Access as probed", () => {
    expect(areaStatus("fullDiskAccess", "allowed")).toBe("allowed");
    expect(areaStatus("fullDiskAccess", "denied")).toBe("denied");
    expect(areaStatus("fullDiskAccess", "unknown")).toBe("unknown");
  });

  it("allows every folder and volume through Full Disk Access", () => {
    for (const area of FOLDERS) {
      expect(areaStatus(area, "allowed")).toBe("allowed");
    }
  });

  it("never guesses a folder's own switch", () => {
    // Without Full Disk Access only opening the folder would tell, and that
    // can make macOS ask.
    for (const area of FOLDERS) {
      expect(areaStatus(area, "denied")).toBe("askedOnFirstUse");
      expect(areaStatus(area, "unknown")).toBe("askedOnFirstUse");
    }
  });
});

describe("settingsPaneFor", () => {
  it("opens Full Disk Access for itself and Files & Folders for the rest", () => {
    expect(settingsPaneFor("fullDiskAccess")).toBe("fullDiskAccess");
    for (const area of FOLDERS) {
      expect(settingsPaneFor(area)).toBe("filesAndFolders");
    }
  });
});

describe("PRIVACY_AREAS", () => {
  it("lists Full Disk Access first and each area once", () => {
    expect(PRIVACY_AREAS[0]).toBe("fullDiskAccess");
    expect(new Set(PRIVACY_AREAS).size).toBe(PRIVACY_AREAS.length);
    expect(PRIVACY_AREAS).toHaveLength(8);
  });
});
