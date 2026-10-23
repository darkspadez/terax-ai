import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  IS_MAC: true,
  main: true,
  answered: vi.fn(async () => false),
  keep: vi.fn(async () => {}),
  suggest: vi.fn(async (_keep: () => Promise<void>) => {}),
}));

// Runs the effect at once, so the hook can be called as a function.
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
vi.mock("@/lib/platform", () => env);
vi.mock("@/lib/appWindow", () => ({ isMainWindow: () => env.main }));
vi.mock("@/modules/settings/store", () => ({
  macFullDiskAccessSuggested: env.answered,
  setMacFullDiskAccessSuggested: env.keep,
}));
vi.mock("./firstRun", () => ({ suggestFullDiskAccess: env.suggest }));

async function launch() {
  vi.resetModules();
  const { useFullDiskAccessSuggestion } = await import(
    "./useFullDiskAccessSuggestion"
  );
  return useFullDiskAccessSuggestion;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  env.IS_MAC = true;
  env.main = true;
  env.answered.mockReset();
  env.answered.mockResolvedValue(false);
  env.suggest.mockClear();
});

describe("useFullDiskAccessSuggestion", () => {
  it("suggests it from the main window until answered, keeping the answer", async () => {
    (await launch())();
    await settle();
    expect(env.suggest).toHaveBeenCalledExactlyOnceWith(env.keep);
  });

  it("loads nothing once the notice has been answered", async () => {
    env.answered.mockResolvedValue(true);
    (await launch())();
    await settle();
    expect(env.suggest).not.toHaveBeenCalled();
  });

  it("asks once per launch, however often the window renders", async () => {
    const use = await launch();
    use();
    use();
    await settle();
    expect(env.answered).toHaveBeenCalledOnce();
    expect(env.suggest).toHaveBeenCalledOnce();
  });

  it("stays silent in other windows and off macOS", async () => {
    env.main = false;
    (await launch())();
    env.main = true;
    env.IS_MAC = false;
    (await launch())();
    await settle();
    expect(env.answered).not.toHaveBeenCalled();
    expect(env.suggest).not.toHaveBeenCalled();
  });
});
