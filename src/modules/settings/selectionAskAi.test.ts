import { beforeEach, describe, expect, it, vi } from "vitest";

// `store` is created at module load, so the plugin mocks must be in place
// before `./store` is imported.
const plugin = vi.hoisted(() => ({
  entries: [] as [string, unknown][],
  written: [] as [string, unknown][],
  emitted: [] as [string, unknown][],
  onEvent: null as
    | ((event: { payload: { key: string; value: unknown } }) => void)
    | null,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    entries = async () => plugin.entries;
    get = async () => undefined;
    set = async (key: string, value: unknown) => {
      plugin.written.push([key, value]);
    };
    save = async () => undefined;
    onChange = async () => () => undefined;
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
  invoke: async () => undefined,
  convertFileSrc: (path: string) => path,
}));

beforeEach(() => {
  plugin.entries = [];
  plugin.written = [];
  plugin.emitted = [];
  plugin.onEvent = null;
  vi.resetModules();
});

// crynta/terax-ai#852: the Ask Oarlock button on a selection can be turned off.
describe("the Ask Oarlock on selection setting", () => {
  it("is on unless it was explicitly turned off", async () => {
    const { coerceSelectionAskAi, DEFAULT_PREFERENCES, loadPreferences } =
      await import("./store");
    expect(DEFAULT_PREFERENCES.selectionAskAi).toBe(true);
    expect(coerceSelectionAskAi(undefined)).toBe(true);
    expect(coerceSelectionAskAi(true)).toBe(true);
    expect(coerceSelectionAskAi(false)).toBe(false);
    expect(coerceSelectionAskAi("false")).toBe(true);
    expect(coerceSelectionAskAi(0)).toBe(true);

    expect((await loadPreferences()).selectionAskAi).toBe(true);
    plugin.entries = [["selectionAskAi", false]];
    expect((await loadPreferences()).selectionAskAi).toBe(false);
    plugin.entries = [["selectionAskAi", null]];
    expect((await loadPreferences()).selectionAskAi).toBe(true);
  });

  it("is stored, announced and followed by every window", async () => {
    const { onPreferencesChange, setSelectionAskAi } = await import("./store");
    const seen: [string, unknown][] = [];
    await onPreferencesChange((key, value) => seen.push([key, value]));

    await setSelectionAskAi(false);
    expect(plugin.written).toEqual([["selectionAskAi", false]]);
    expect(plugin.emitted.map(([, payload]) => payload)).toEqual([
      { key: "selectionAskAi", value: false },
    ]);

    plugin.onEvent?.({ payload: { key: "selectionAskAi", value: true } });
    expect(seen).toEqual([["selectionAskAi", true]]);
  });
});
