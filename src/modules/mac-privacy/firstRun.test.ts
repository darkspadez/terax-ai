import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  toast: vi.fn(),
  keep: vi.fn(async () => {}),
  fullDiskAccess: vi.fn(async (): Promise<string> => "denied"),
  openPrivacySettings: vi.fn(async () => {}),
}));

vi.mock("sonner", () => ({ toast: env.toast }));
vi.mock("./native", () => ({
  fullDiskAccess: env.fullDiskAccess,
  openPrivacySettings: env.openPrivacySettings,
}));

import { suggestFullDiskAccess } from "./firstRun";

type Notice = {
  duration: number;
  action: { label: string; onClick: () => void };
  cancel: { label: string; onClick: () => void };
  onDismiss: () => void;
};

function shownNotice(): Notice {
  expect(env.toast).toHaveBeenCalledOnce();
  return env.toast.mock.calls[0][1] as Notice;
}

beforeEach(() => {
  env.toast.mockReset();
  env.keep.mockClear();
  env.fullDiskAccess.mockReset();
  env.fullDiskAccess.mockResolvedValue("denied");
  env.openPrivacySettings.mockClear();
});

describe("suggestFullDiskAccess", () => {
  it("suggests it in a notice that stays until answered", async () => {
    await suggestFullDiskAccess(env.keep);
    const notice = shownNotice();
    expect(notice.duration).toBe(Number.POSITIVE_INFINITY);
    expect(notice.action.label).toBe("Open System Settings");
    expect(notice.cancel.label).toBe("Not now");
  });

  it("opens Full Disk Access and keeps the answer", async () => {
    await suggestFullDiskAccess(env.keep);
    const notice = shownNotice();
    notice.action.onClick();
    // Should Sonner report the dismissal as well, the answer is kept once.
    notice.onDismiss();
    expect(env.openPrivacySettings).toHaveBeenCalledWith("fullDiskAccess");
    expect(env.keep).toHaveBeenCalledOnce();
  });

  it("keeps Not now, or closing the notice, as the answer", async () => {
    await suggestFullDiskAccess(env.keep);
    shownNotice().cancel.onClick();
    expect(env.keep).toHaveBeenCalledOnce();
    expect(env.openPrivacySettings).not.toHaveBeenCalled();

    env.toast.mockReset();
    env.keep.mockClear();
    await suggestFullDiskAccess(env.keep);
    shownNotice().onDismiss();
    expect(env.keep).toHaveBeenCalledOnce();
  });

  it("never shows when Terax has Full Disk Access or may have it", async () => {
    for (const access of ["allowed", "unknown"]) {
      env.fullDiskAccess.mockResolvedValue(access);
      await suggestFullDiskAccess(env.keep);
    }
    env.fullDiskAccess.mockRejectedValue(new Error("ipc"));
    await suggestFullDiskAccess(env.keep);
    expect(env.toast).not.toHaveBeenCalled();
    expect(env.keep).not.toHaveBeenCalled();
  });
});
