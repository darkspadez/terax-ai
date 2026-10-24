import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  IS_MAC: true,
  toast: { error: vi.fn(), dismiss: vi.fn() },
  homeDir: vi.fn(async () => "/Users/me"),
  fullDiskAccess: vi.fn(async (): Promise<string> => "denied"),
  openPrivacySettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/platform", () => env);
vi.mock("sonner", () => ({ toast: env.toast }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: env.homeDir }));
vi.mock("./native", () => ({
  fullDiskAccess: env.fullDiskAccess,
  openPrivacySettings: env.openPrivacySettings,
}));

const EPERM = "Operation not permitted (os error 1)";
const DESKTOP_FILE = "/Users/me/Desktop/notes.md";

// The module keeps the home folder and Full Disk Access between calls.
async function load() {
  vi.resetModules();
  return import("./fileErrors");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
  env.IS_MAC = true;
  env.toast.error.mockReset();
  env.toast.dismiss.mockReset();
  env.homeDir.mockClear();
  env.fullDiskAccess.mockReset();
  env.fullDiskAccess.mockResolvedValue("denied");
  env.openPrivacySettings.mockClear();
});

describe("explainFileError", () => {
  it("names the grant and its pane for a refusal in a protected place", async () => {
    const { explainFileError } = await load();
    expect(await explainFileError(DESKTOP_FILE, EPERM)).toEqual({
      area: "desktop",
      message:
        "macOS privacy settings do not allow Oarlock to use your Desktop folder.",
      pane: "filesAndFolders",
    });
    expect(await explainFileError("/Volumes/USB/a", EPERM)).toMatchObject({
      area: "volumes",
      pane: "filesAndFolders",
    });
    expect(
      await explainFileError("/Users/me/Library/Mail/V10", EPERM),
    ).toMatchObject({ area: "fullDiskAccess", pane: "fullDiskAccess" });
  });

  it("explains nothing when Oarlock has Full Disk Access", async () => {
    env.fullDiskAccess.mockResolvedValue("allowed");
    const { explainFileError } = await load();
    expect(await explainFileError(DESKTOP_FILE, EPERM)).toBeNull();
  });

  it("explains a refusal when Full Disk Access cannot be told", async () => {
    env.fullDiskAccess.mockRejectedValue(new Error("ipc"));
    const { explainFileError } = await load();
    expect(await explainFileError(DESKTOP_FILE, EPERM)).toMatchObject({
      area: "desktop",
    });
  });

  it("asks nothing for other errors or other places", async () => {
    const { explainFileError } = await load();
    expect(
      await explainFileError(DESKTOP_FILE, "Permission denied (os error 13)"),
    ).toBeNull();
    expect(env.homeDir).not.toHaveBeenCalled();
    expect(await explainFileError("/Users/me/src/a.ts", EPERM)).toBeNull();
    expect(env.fullDiskAccess).not.toHaveBeenCalled();
  });

  it("asks nothing off macOS", async () => {
    env.IS_MAC = false;
    const { explainFileError } = await load();
    expect(await explainFileError(DESKTOP_FILE, EPERM)).toBeNull();
    expect(env.homeDir).not.toHaveBeenCalled();
    expect(env.fullDiskAccess).not.toHaveBeenCalled();
  });

  it("checks Full Disk Access once until the window regains focus", async () => {
    const { explainFileError } = await load();
    await explainFileError(DESKTOP_FILE, EPERM);
    await explainFileError("/Users/me/Documents/a", EPERM);
    expect(env.fullDiskAccess).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("focus"));
    await explainFileError(DESKTOP_FILE, EPERM);
    expect(env.fullDiskAccess).toHaveBeenCalledTimes(2);
  });
});

describe("showFileError", () => {
  it("shows exactly the old toast off macOS and for other errors", async () => {
    const { showFileError } = await load();
    env.IS_MAC = false;
    showFileError("Paste failed: x", { path: DESKTOP_FILE, error: EPERM });
    expect(env.toast.error).toHaveBeenLastCalledWith("Paste failed: x");
    env.IS_MAC = true;
    showFileError("Could not save a.md", {
      path: DESKTOP_FILE,
      error: "No space left on device (os error 28)",
      id: "save-error:a",
      description: "No space left on device (os error 28)",
    });
    expect(env.toast.error).toHaveBeenLastCalledWith("Could not save a.md", {
      id: "save-error:a",
      description: "No space left on device (os error 28)",
    });
  });

  it("explains a refusal with a way to System Settings", async () => {
    const { showFileError } = await load();
    showFileError("Could not save notes.md", {
      path: DESKTOP_FILE,
      error: EPERM,
      id: "save-error:notes",
      description: EPERM,
    });
    expect(env.toast.error).not.toHaveBeenCalled();
    await settle();
    expect(env.toast.error).toHaveBeenCalledOnce();
    const [title, options] = env.toast.error.mock.calls[0];
    expect(title).toBe("Could not save notes.md");
    expect(options).toMatchObject({
      id: "save-error:notes",
      description:
        "macOS privacy settings do not allow Oarlock to use your Desktop folder.",
      action: { label: "Open System Settings" },
    });
    options.action.onClick();
    expect(env.openPrivacySettings).toHaveBeenCalledWith("filesAndFolders");
  });

  it("falls back to the old toast when Full Disk Access rules a refusal out", async () => {
    env.fullDiskAccess.mockResolvedValue("allowed");
    const { showFileError } = await load();
    showFileError("Could not delete a", { path: DESKTOP_FILE, error: EPERM });
    await settle();
    expect(env.toast.error).toHaveBeenCalledExactlyOnceWith(
      "Could not delete a",
    );
  });

  it("drops an explanation the toast was dismissed or replaced before", async () => {
    const { dismissFileError, showFileError } = await load();
    showFileError("Could not save a", {
      path: DESKTOP_FILE,
      error: EPERM,
      id: "save-error:a",
    });
    dismissFileError("save-error:a");
    expect(env.toast.dismiss).toHaveBeenCalledWith("save-error:a");
    await settle();
    expect(env.toast.error).not.toHaveBeenCalled();

    showFileError("Could not save a", {
      path: DESKTOP_FILE,
      error: EPERM,
      id: "save-error:a",
    });
    showFileError("Could not save a", {
      path: DESKTOP_FILE,
      error: "Disk full",
      id: "save-error:a",
      description: "Disk full",
    });
    await settle();
    expect(env.toast.error).toHaveBeenCalledExactlyOnceWith(
      "Could not save a",
      { id: "save-error:a", description: "Disk full" },
    );
  });
});

describe("showPrivacyRefusal", () => {
  it("speaks up only for a privacy refusal", async () => {
    const { showPrivacyRefusal } = await load();
    showPrivacyRefusal("Could not rename a", {
      path: "/Users/me/src/a",
      error: EPERM,
    });
    showPrivacyRefusal("Could not rename a", {
      path: DESKTOP_FILE,
      error: "File exists (os error 17)",
    });
    await settle();
    expect(env.toast.error).not.toHaveBeenCalled();

    showPrivacyRefusal("Could not rename notes.md", {
      path: DESKTOP_FILE,
      error: EPERM,
    });
    await settle();
    expect(env.toast.error).toHaveBeenCalledOnce();
    expect(env.toast.error.mock.calls[0][0]).toBe("Could not rename notes.md");
  });
});
