import { beforeEach, describe, expect, it, vi } from "vitest";

const prefsMock = vi.hoisted(() => ({
  favoriteModelIds: [] as string[],
  recentModelIds: [] as string[],
  reasoningEffortByModel: {} as Record<string, string>,
}));

const storeMock = vi.hoisted(() => ({
  setFavoriteModelIds: vi.fn(),
  setRecentModelIds: vi.fn(),
  setReasoningEffortByModel: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      favoriteModelIds: prefsMock.favoriteModelIds,
      recentModelIds: prefsMock.recentModelIds,
      reasoningEffortByModel: prefsMock.reasoningEffortByModel,
    }),
  },
}));

vi.mock("@/modules/settings/store", () => storeMock);

import {
  pushRecentModel,
  setModelReasoningEffort,
  toggleFavoriteModel,
} from "./modelPrefs";

beforeEach(() => {
  prefsMock.favoriteModelIds = [];
  prefsMock.recentModelIds = [];
  storeMock.setFavoriteModelIds.mockClear();
  storeMock.setRecentModelIds.mockClear();
  storeMock.setReasoningEffortByModel.mockClear();
  prefsMock.reasoningEffortByModel = {};
});

describe("toggleFavoriteModel", () => {
  it("adds an id when absent", async () => {
    prefsMock.favoriteModelIds = ["a"];
    await toggleFavoriteModel("b");
    expect(storeMock.setFavoriteModelIds).toHaveBeenCalledWith(["a", "b"]);
  });

  it("removes an id when already present", async () => {
    prefsMock.favoriteModelIds = ["a", "b"];
    await toggleFavoriteModel("a");
    expect(storeMock.setFavoriteModelIds).toHaveBeenCalledWith(["b"]);
  });

  it("propagates a write failure", async () => {
    storeMock.setFavoriteModelIds.mockRejectedValueOnce(new Error("ipc down"));
    await expect(toggleFavoriteModel("a")).rejects.toThrow("ipc down");
  });
});

describe("pushRecentModel", () => {
  it("appends a new id to an empty list", async () => {
    prefsMock.recentModelIds = [];
    await pushRecentModel("a");
    expect(storeMock.setRecentModelIds).toHaveBeenCalledWith(["a"]);
  });

  it("moves an existing id to the front", async () => {
    prefsMock.recentModelIds = ["a", "b", "c"];
    await pushRecentModel("b");
    expect(storeMock.setRecentModelIds).toHaveBeenCalledWith(["b", "a", "c"]);
  });

  it("deduplicates before capping a full list", async () => {
    prefsMock.recentModelIds = ["a", "b", "c", "d", "e"];
    await pushRecentModel("c");
    expect(storeMock.setRecentModelIds).toHaveBeenCalledWith([
      "c",
      "a",
      "b",
      "d",
      "e",
    ]);
  });

  it("caps the list at five entries", async () => {
    prefsMock.recentModelIds = ["e", "d", "c", "b", "a"];
    await pushRecentModel("x");
    expect(storeMock.setRecentModelIds).toHaveBeenCalledWith([
      "x",
      "e",
      "d",
      "c",
      "b",
    ]);
  });

  it("is a no-op when the id is already most recent", async () => {
    prefsMock.recentModelIds = ["a", "b"];
    await pushRecentModel("a");
    expect(storeMock.setRecentModelIds).not.toHaveBeenCalled();
  });

  it("propagates a write failure", async () => {
    storeMock.setRecentModelIds.mockRejectedValueOnce(new Error("ipc down"));
    await expect(pushRecentModel("a")).rejects.toThrow("ipc down");
  });
});

describe("setModelReasoningEffort", () => {
  it("remembers the effort per model, keeping the others", async () => {
    prefsMock.reasoningEffortByModel = { "gpt-5.6": "low" };
    await setModelReasoningEffort("claude-sonnet-5", "high");
    expect(storeMock.setReasoningEffortByModel).toHaveBeenCalledWith({
      "gpt-5.6": "low",
      "claude-sonnet-5": "high",
    });
  });

  it("writes nothing when the effort is unchanged", async () => {
    prefsMock.reasoningEffortByModel = { "gpt-5.6": "low" };
    await setModelReasoningEffort("gpt-5.6", "low");
    expect(storeMock.setReasoningEffortByModel).not.toHaveBeenCalled();
  });
});
