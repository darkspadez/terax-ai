import { beforeEach, describe, expect, it, vi } from "vitest";

// `store` is created at module load, so the plugin mock must be in place
// before `./store` is imported.
const entries = vi.hoisted(() => ({ value: [] as [string, unknown][] }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    entries = async () => entries.value;
    get = async () => undefined;
    set = async () => undefined;
    save = async () => undefined;
  },
  Store: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: async () => undefined,
  listen: async () => () => undefined,
}));

const endpoint = {
  id: "ab12cd34",
  name: "OpenCode Go",
  baseURL: "https://opencode.ai/zen/go/v1",
  modelId: "deepseek-v4-pro",
  contextLimit: 128_000,
};

async function load() {
  const { loadPreferences } = await import("./store");
  return loadPreferences();
}

describe("custom endpoint preferences across a restart", () => {
  beforeEach(() => {
    entries.value = [];
    vi.resetModules();
  });

  it("keeps a custom endpoint as the default, a favorite and a recent", async () => {
    entries.value = [
      ["customEndpoints", [endpoint]],
      ["defaultModelId", "compat-ab12cd34"],
      ["favoriteModelIds", ["compat-ab12cd34", "gpt-5.4-mini"]],
      ["recentModelIds", ["compat-ab12cd34"]],
    ];
    const prefs = await load();
    expect(prefs.defaultModelId).toBe("compat-ab12cd34");
    expect(prefs.favoriteModelIds).toEqual(["compat-ab12cd34", "gpt-5.4-mini"]);
    expect(prefs.recentModelIds).toEqual(["compat-ab12cd34"]);
  });

  it("drops ids of deleted or unfinished endpoints and unknown models", async () => {
    entries.value = [
      ["customEndpoints", [{ ...endpoint, id: "draft001", modelId: "" }]],
      ["defaultModelId", "compat-ab12cd34"],
      [
        "favoriteModelIds",
        ["compat-draft001", "no-such-model", "gpt-5.4-mini"],
      ],
      ["recentModelIds", ["compat-ab12cd34"]],
    ];
    const prefs = await load();
    expect(prefs.defaultModelId).toBe("gpt-5.4-mini");
    expect(prefs.favoriteModelIds).toEqual(["gpt-5.4-mini"]);
    expect(prefs.recentModelIds).toEqual([]);
  });

  it("gives the migrated legacy endpoint the same id on every load", async () => {
    entries.value = [
      ["openaiCompatibleBaseURL", "https://llm.example.com/v1"],
      ["openaiCompatibleModelId", "llama-3.3-70b"],
    ];
    const first = await load();
    expect(first.customEndpoints).toHaveLength(1);
    const id = `compat-${first.customEndpoints[0].id}`;

    vi.resetModules();
    entries.value = [
      ["openaiCompatibleBaseURL", "https://llm.example.com/v1"],
      ["openaiCompatibleModelId", "llama-3.3-70b"],
      ["defaultModelId", id],
      ["recentModelIds", [id]],
    ];
    const second = await load();
    expect(second.customEndpoints).toEqual(first.customEndpoints);
    expect(second.defaultModelId).toBe(id);
    expect(second.recentModelIds).toEqual([id]);
  });

  it("does not bring back a legacy endpoint the user removed", async () => {
    entries.value = [
      ["openaiCompatibleBaseURL", "https://llm.example.com/v1"],
      ["openaiCompatibleModelId", "llama-3.3-70b"],
      ["customEndpoints", []],
    ];
    expect((await load()).customEndpoints).toEqual([]);
  });
});
