import { beforeEach, describe, expect, it, vi } from "vitest";

// `store` is created at module load, so the plugin mocks must be in place
// before `./store` is imported.
const plugin = vi.hoisted(() => ({
  entries: [] as [string, unknown][],
  written: [] as [string, unknown][],
  emitted: [] as [string, unknown][],
  onLocalChange: null as ((key: string, value: unknown) => void) | null,
  onEvent: null as
    | ((event: { payload: { key: string; value: unknown } }) => void)
    | null,
}));
const invoke = vi.hoisted(() =>
  vi.fn(async (_command: string, _args?: unknown) => undefined),
);

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    entries = async () => plugin.entries;
    get = async () => undefined;
    set = async (key: string, value: unknown) => {
      plugin.written.push([key, value]);
      plugin.onLocalChange?.(key, value);
    };
    save = async () => undefined;
    onChange = async (cb: (key: string, value: unknown) => void) => {
      plugin.onLocalChange = cb;
      return () => undefined;
    };
  },
  Store: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: async (event: string, payload: unknown) => {
    plugin.emitted.push([event, payload]);
  },
  listen: async (
    _event: string,
    cb: (event: { payload: { key: string; value: unknown } }) => void,
  ) => {
    plugin.onEvent = cb;
    return () => undefined;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: (path: string) => path,
}));

const sent = () =>
  invoke.mock.calls
    .filter(([command]) => command === "workspace_set_all_folders")
    .map(([, args]) => args);

/** Lets every settled promise run its callbacks. */
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  plugin.entries = [];
  plugin.written = [];
  plugin.emitted = [];
  plugin.onLocalChange = null;
  plugin.onEvent = null;
  invoke.mockClear();
  vi.resetModules();
});

describe("the access-all-folders settings", () => {
  it("are off unless a true was stored", async () => {
    const { DEFAULT_PREFERENCES, loadPreferences } = await import("./store");
    expect(DEFAULT_PREFERENCES.appAllFolders).toBe(false);
    expect(DEFAULT_PREFERENCES.aiAllFolders).toBe(false);
    expect(await loadPreferences()).toMatchObject({
      appAllFolders: false,
      aiAllFolders: false,
    });

    plugin.entries = [
      ["appAllFolders", "true"],
      ["aiAllFolders", 1],
    ];
    expect(await loadPreferences()).toMatchObject({
      appAllFolders: false,
      aiAllFolders: false,
    });

    plugin.entries = [
      ["appAllFolders", true],
      ["aiAllFolders", false],
    ];
    expect(await loadPreferences()).toMatchObject({
      appAllFolders: true,
      aiAllFolders: false,
    });
  });

  it("are stored on their own and announced to other windows", async () => {
    const { setAiAllFolders, setAppAllFolders } = await import("./store");
    await setAppAllFolders(true);
    await setAiAllFolders(false);
    expect(plugin.written).toEqual([
      ["appAllFolders", true],
      ["aiAllFolders", false],
    ]);
    expect(plugin.emitted.map(([, payload]) => payload)).toEqual([
      { key: "appAllFolders", value: true },
      { key: "aiAllFolders", value: false },
    ]);
  });

  it("reach the backend when a window starts and on every change", async () => {
    plugin.entries = [["aiAllFolders", true]];
    const { usePreferencesStore } = await import("./preferences");
    await usePreferencesStore.getState().init();
    await settle();
    expect(sent()).toEqual([
      { origin: "app", all: false },
      { origin: "ai", all: true },
    ]);

    // Changed in this window.
    invoke.mockClear();
    const { setAppAllFolders } = await import("./store");
    await setAppAllFolders(true);
    await settle();
    expect(sent()).toEqual([{ origin: "app", all: true }]);

    // Changed in another window (Settings).
    invoke.mockClear();
    plugin.onEvent?.({ payload: { key: "aiAllFolders", value: false } });
    await settle();
    expect(sent()).toEqual([{ origin: "ai", all: false }]);

    // Unrelated settings send nothing.
    invoke.mockClear();
    plugin.onEvent?.({ payload: { key: "showHidden", value: true } });
    await settle();
    expect(sent()).toEqual([]);
  });
});
