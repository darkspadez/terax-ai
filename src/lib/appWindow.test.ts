import { describe, expect, it } from "vitest";
import {
  activeChatKey,
  isAppWindowLabel,
  isMainWindow,
  launchCwdFromUrl,
  launchFolderFromUrl,
  spacesStorePath,
  withoutLaunchParams,
} from "./appWindow";

describe("app windows", () => {
  it("keeps the main window's state where it always was", () => {
    expect(spacesStorePath("main")).toBe("oarlock-spaces.json");
    expect(activeChatKey("main")).toBe("activeId");
    // Outside Tauri the page is the main window.
    expect(isMainWindow()).toBe(true);
  });

  // Mirrors `spaces_store` and `active_chat_key` in `windows.rs`.
  it("gives every other window its own spaces and active chat", () => {
    expect(spacesStorePath("w-1a2b")).toBe("windows/w-1a2b/oarlock-spaces.json");
    expect(activeChatKey("w-1a2b")).toBe("activeId:w-1a2b");
    expect(isMainWindow("w-1a2b")).toBe(false);
  });

  it("recognises app window labels as windows.rs does", () => {
    for (const label of ["main", "w-1", `w-${"a".repeat(32)}`]) {
      expect(isAppWindowLabel(label)).toBe(true);
    }
    for (const label of ["quick", "settings", "w-", "w-a/b", `w-${"a".repeat(33)}`]) {
      expect(isAppWindowLabel(label)).toBe(false);
    }
  });

  it("reads a new window's directory from its URL", () => {
    expect(launchCwdFromUrl("?cwd=/home/me/my%20proj")).toBe("/home/me/my proj");
    expect(launchCwdFromUrl("?cwd=C%3A%5Ca%26b")).toBe("C:\\a&b");
    expect(launchCwdFromUrl("")).toBeNull();
    expect(launchCwdFromUrl("?cwd=")).toBeNull();
  });

  // Mirrors `window_url` in `windows.rs`.
  it("reads the folder a later launch opened the window on", () => {
    expect(launchFolderFromUrl("?folder=C%3A/work/a%26b")).toBe("C:/work/a&b");
    expect(launchFolderFromUrl("?cwd=/home/me")).toBeNull();
    expect(launchFolderFromUrl("?folder=")).toBeNull();
  });

  it("drops the launch parameters so a reload does not reopen them", () => {
    expect(withoutLaunchParams("?folder=%2Fa")).toBe("");
    expect(withoutLaunchParams("?cwd=%2Fa&debug=1")).toBe("?debug=1");
    expect(withoutLaunchParams("")).toBe("");
  });
});
