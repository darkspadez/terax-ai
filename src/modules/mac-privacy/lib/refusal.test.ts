import { describe, expect, it } from "vitest";
import { settingsPaneFor } from "./areas";
import { isOperationNotPermitted } from "./operationNotPermitted";
import { privacyRefusal, refusalMessage } from "./refusal";

const HOME = "/Users/me";
const EPERM = "Operation not permitted (os error 1)";
const EACCES = "Permission denied (os error 13)";

describe("isOperationNotPermitted", () => {
  it("recognizes EPERM as Rust and git word it", () => {
    expect(isOperationNotPermitted(EPERM)).toBe(true);
    expect(
      isOperationNotPermitted(
        "fatal: cannot open '.git/HEAD': Operation not permitted",
      ),
    ).toBe(true);
    expect(isOperationNotPermitted(new Error(EPERM))).toBe(true);
    expect(isOperationNotPermitted({ message: EPERM })).toBe(true);
  });

  it("leaves ordinary permission and other errors alone", () => {
    expect(isOperationNotPermitted(EACCES)).toBe(false);
    expect(isOperationNotPermitted("Permission denied")).toBe(false);
    expect(isOperationNotPermitted("Read-only file system (os error 30)")).toBe(
      false,
    );
    expect(isOperationNotPermitted("Is a directory (os error 21)")).toBe(false);
    expect(isOperationNotPermitted("Too many open files (os error 24)")).toBe(
      false,
    );
    expect(
      isOperationNotPermitted("No such file or directory (os error 2)"),
    ).toBe(false);
    expect(isOperationNotPermitted(null)).toBe(false);
    expect(isOperationNotPermitted(undefined)).toBe(false);
  });
});

describe("privacyRefusal", () => {
  const refusal = (path: string | string[], error = EPERM, home = HOME) =>
    privacyRefusal(path, error, home);

  it("names the folder macOS guards", () => {
    expect(refusal("/Users/me/Desktop")).toBe("desktop");
    expect(refusal("/Users/me/Desktop/notes.md")).toBe("desktop");
    expect(refusal("/Users/me/Documents/project/src/main.rs")).toBe(
      "documents",
    );
    expect(refusal("/Users/me/Downloads/archive.zip")).toBe("downloads");
    expect(
      refusal(
        "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Plans/q3.md",
      ),
    ).toBe("iCloudDrive");
  });

  it("names Full Disk Access for the places only it opens", () => {
    for (const path of [
      "/Users/me/Library/Mail/V10",
      "/Users/me/Library/Messages/chat.db",
      "/Users/me/Library/Safari/Bookmarks.plist",
      "/Users/me/Library/Cookies",
      "/Users/me/Library/Application Support/com.apple.TCC/TCC.db",
      "/Users/me/Library/Application Support/MobileSync/Backup",
      "/Library/Application Support/com.apple.TCC/TCC.db",
      "/Library/Preferences/com.apple.TimeMachine.plist",
    ]) {
      expect(refusal(path), path).toBe("fullDiskAccess");
    }
  });

  it("names removable and network volumes for anything on a volume", () => {
    expect(refusal("/Volumes/USB")).toBe("volumes");
    expect(refusal("/Volumes/USB/photos/1.jpg")).toBe("volumes");
    expect(refusal("/Volumes/share on nas/report.pdf")).toBe("volumes");
    // Listing the mount points themselves is not protected.
    expect(refusal("/Volumes")).toBeNull();
  });

  it("never fires for an ordinary permission error", () => {
    for (const path of [
      "/Users/me/Desktop/notes.md",
      "/Users/me/Library/Mail",
      "/Volumes/USB/file",
    ]) {
      expect(refusal(path, EACCES), path).toBeNull();
    }
    expect(refusal("/Users/me/Documents/x", "No such file or directory")).toBe(
      null,
    );
  });

  it("never fires outside the protected places", () => {
    for (const path of [
      "/Users/me",
      "/Users/me/projects/app/src/main.ts",
      "/Users/me/Desktop2/x",
      "/Users/me/DesktopStuff",
      "/Users/me/Library",
      "/Users/me/Library/Preferences/com.example.plist",
      "/Users/me/Library/Mobile",
      "/Users/other/Desktop/x",
      "/System/Library/CoreServices",
      "/usr/local/bin/tool",
      "/etc/hosts",
      "/private/var/db",
      "/Library/Application Support/Example",
      "Desktop/relative.txt",
      "",
    ]) {
      expect(refusal(path), path).toBeNull();
    }
  });

  it("compares paths as macOS does by default, without regard to case", () => {
    expect(refusal("/users/ME/desktop/notes.md")).toBe("desktop");
    expect(refusal("/VOLUMES/usb/x")).toBe("volumes");
    expect(refusal("/Users/me/Documents", EPERM, "/USERS/ME/")).toBe(
      "documents",
    );
  });

  it("reads the path as written, separators and dot segments resolved", () => {
    expect(refusal("/Users/me/Desktop/")).toBe("desktop");
    expect(refusal("//Users//me///Downloads//a")).toBe("downloads");
    expect(refusal("/Users/me/projects/../Desktop/x")).toBe("desktop");
    expect(refusal("/Users/me/Desktop/../projects/x")).toBeNull();
    expect(refusal("/Users/me/./Documents/x")).toBe("documents");
  });

  it("needs the home folder only for the places in it", () => {
    expect(privacyRefusal("/Users/me/Desktop/x", EPERM, null)).toBeNull();
    expect(privacyRefusal("/Volumes/USB/x", EPERM, null)).toBe("volumes");
    expect(
      privacyRefusal(
        "/Library/Application Support/com.apple.TCC/TCC.db",
        EPERM,
        null,
      ),
    ).toBe("fullDiskAccess");
    // A home at the root would make every path a home path.
    expect(privacyRefusal("/Desktop/x", EPERM, "/")).toBeNull();
  });

  it("takes the first protected path of several", () => {
    expect(
      refusal(["/Users/me/projects/out", "/Users/me/Downloads/in.txt"]),
    ).toBe("downloads");
    expect(refusal(["/Volumes/USB/a", "/Users/me/Desktop"])).toBe("volumes");
    expect(refusal(["/tmp/a", "/tmp/b"])).toBeNull();
    expect(refusal([])).toBeNull();
  });
});

describe("refusalMessage", () => {
  it("names the place and where to allow it", () => {
    expect(refusalMessage("desktop")).toMatch(/Desktop folder/);
    expect(refusalMessage("documents")).toMatch(/Documents folder/);
    expect(refusalMessage("downloads")).toMatch(/Downloads folder/);
    expect(refusalMessage("iCloudDrive")).toMatch(/iCloud Drive/);
    expect(refusalMessage("volumes")).toMatch(/removable or network volumes/);
    expect(refusalMessage("fullDiskAccess")).toMatch(/Full Disk Access/);
    expect(settingsPaneFor("volumes")).toBe("filesAndFolders");
  });
});
