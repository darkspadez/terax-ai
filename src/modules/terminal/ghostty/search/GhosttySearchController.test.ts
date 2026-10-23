import { describe, expect, it, vi } from "vitest";
import type {
  GhosttySearchStatus,
  GhosttyTerminalModelApi,
} from "../GhosttyTerminalModel";
import {
  GhosttySearchController,
  searchMatchCount,
} from "./GhosttySearchController";
import { MAX_REGEX_MATCHES } from "./RegexTerminalSearch";

const pendingStatus: GhosttySearchStatus = {
  active: true,
  pending: true,
  complete: false,
  generation: 1,
  totalMatches: 1,
  selectedIndex: -1,
};

const completeStatus: GhosttySearchStatus = {
  active: true,
  pending: false,
  complete: true,
  generation: 1,
  totalMatches: 2,
  selectedIndex: -1,
};

describe("GhosttySearchController", () => {
  it("renders block matches without starting a whole-terminal search", () => {
    let active = true;
    const model = {
      cols: 5,
      rows: 1,
      blockSearchActive: () => active,
      searchViewportMatches: () => [
        { row: 0, startColumn: 1, endColumn: 4, selected: true },
      ],
      setSearchQuery: vi.fn(),
    } as unknown as GhosttyTerminalModelApi;
    const controller = new GhosttySearchController(model, vi.fn());
    controller.refresh();
    expect(controller.matchAt(0, 2)).toBe(2);
    expect(model.setSearchQuery).not.toHaveBeenCalled();
    active = false;
    controller.refresh();
    expect(controller.matchAt(0, 2)).toBe(0);
    controller.dispose();
  });
  it("exposes the highlight mask with a revision that moves only when cells change", () => {
    let spans = [{ row: 0, startColumn: 1, endColumn: 3, selected: false }];
    const model = {
      cols: 6,
      rows: 2,
      blockSearchActive: () => true,
      searchViewportMatches: () => spans,
    } as unknown as GhosttyTerminalModelApi;
    const controller = new GhosttySearchController(model, vi.fn());
    expect(controller.viewportMaskBytes()).toBeNull();
    controller.refreshOverlay();
    const revision = controller.maskRevision;
    expect([...(controller.viewportMaskBytes() ?? [])]).toEqual([
      0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    for (let frame = 0; frame < 50; frame += 1) controller.refreshOverlay();
    expect(controller.maskRevision).toBe(revision);

    spans = [{ row: 1, startColumn: 0, endColumn: 2, selected: true }];
    controller.refreshOverlay();
    expect(controller.maskRevision).toBe(revision + 1);
    expect([...(controller.viewportMaskBytes() ?? [])].slice(6)).toEqual([
      2, 2, 0, 0, 0, 0,
    ]);

    spans = [];
    controller.refreshOverlay();
    expect(controller.viewportMaskBytes()).toBeNull();
    expect(controller.maskRevision).toBe(revision + 2);
    controller.dispose();
    expect(controller.viewportMaskBytes()).toBeNull();
  });

  it.each([false, true])(
    "restores the native search without resetting or skipping a match (pending: %s)",
    (pending) => {
      let complete = !pending;
      const model = {
        cols: 2,
        rows: 1,
        setSearchQuery: vi.fn(() => pendingStatus),
        stepSearch: vi.fn(() => (complete ? completeStatus : pendingStatus)),
        selectSearchMatch: vi.fn(() => ({
          ...completeStatus,
          selectedIndex: 0,
        })),
        searchViewportMatches: vi.fn(() => [
          { row: 0, startColumn: 0, endColumn: 1, selected: complete },
        ]),
        clearSearch: vi.fn(),
      } as unknown as GhosttyTerminalModelApi;
      const scheduler = { request: vi.fn(() => 42), cancel: vi.fn() };
      const previous = new GhosttySearchController(model, vi.fn(), scheduler);
      previous.findNext("x");
      const snapshot = previous.snapshot();
      previous.dispose();
      complete = true;
      const replacement = new GhosttySearchController(
        model,
        vi.fn(),
        scheduler,
      );
      replacement.restore(snapshot);
      expect(model.setSearchQuery).toHaveBeenCalledOnce();
      expect(model.selectSearchMatch).toHaveBeenCalledOnce();
      expect(replacement.matchAt(0, 0)).toBe(2);
      replacement.findNext("x");
      expect(model.setSearchQuery).toHaveBeenCalledOnce();
      expect(model.selectSearchMatch).toHaveBeenCalledTimes(2);
      replacement.dispose();
      expect(model.clearSearch).not.toHaveBeenCalled();
    },
  );

  it("steps incrementally and retains only viewport match cells", () => {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    let selected = false;
    const model = {
      cols: 5,
      rows: 2,
      setSearchQuery: vi.fn(() => pendingStatus),
      stepSearch: vi
        .fn<() => GhosttySearchStatus>()
        .mockReturnValueOnce(pendingStatus)
        .mockReturnValue(completeStatus),
      selectSearchMatch: vi.fn(() => {
        selected = true;
        return { ...completeStatus, selectedIndex: 0 };
      }),
      searchViewportMatches: vi.fn(() => [
        { row: 1, startColumn: 1, endColumn: 4, selected },
      ]),
      clearSearch: vi.fn(),
    } as unknown as GhosttyTerminalModelApi;
    const onChange = vi.fn();
    const controller = new GhosttySearchController(model, onChange, {
      request: (callback) => {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancel: (handle) => callbacks.delete(handle),
    });

    expect(controller.findNext("agent")).toBe(true);
    expect(model.stepSearch).toHaveBeenCalledWith(256);
    expect(controller.matchAt(1, 2)).toBe(1);
    expect(callbacks.size).toBe(1);

    const callback = callbacks.values().next().value;
    expect(callback).toBeTypeOf("function");
    callback?.();

    expect(model.selectSearchMatch).toHaveBeenCalledWith("next");
    expect(controller.matchAt(1, 2)).toBe(2);
    expect(controller.matchAt(0, 2)).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("coalesces streaming invalidations and cancels work when hidden or disposed", () => {
    let callback: (() => void) | null = null;
    const scheduler = {
      request: vi.fn((next: () => void) => {
        callback = next;
        return 1;
      }),
      cancel: vi.fn(() => {
        callback = null;
      }),
    };
    const model = {
      cols: 2,
      rows: 1,
      setSearchQuery: vi.fn(() => completeStatus),
      stepSearch: vi.fn(() => completeStatus),
      selectSearchMatch: vi.fn(() => completeStatus),
      searchViewportMatches: vi.fn(() => []),
    } as unknown as GhosttyTerminalModelApi;
    const controller = new GhosttySearchController(model, vi.fn(), scheduler);
    controller.invalidate();
    expect(scheduler.request).not.toHaveBeenCalled();
    controller.findNext("agent");
    vi.mocked(model.stepSearch).mockClear();
    vi.mocked(model.searchViewportMatches).mockClear();
    for (let index = 0; index < 1_000; index++) controller.invalidate();
    expect(scheduler.request).toHaveBeenCalledOnce();
    expect(model.stepSearch).not.toHaveBeenCalled();
    expect(model.searchViewportMatches).not.toHaveBeenCalled();
    const run = callback as (() => void) | null;
    run?.();
    expect(model.stepSearch).toHaveBeenCalledOnce();
    expect(model.searchViewportMatches).toHaveBeenCalledOnce();
    controller.invalidate();
    controller.suspend();
    expect(callback).toBeNull();
    scheduler.request.mockClear();
    controller.invalidate();
    expect(scheduler.request).not.toHaveBeenCalled();
    controller.resume();
    controller.invalidate();
    controller.dispose();
    expect(callback).toBeNull();
  });

  it("reports the match count while it grows, once selected, and clears it", () => {
    const callbacks: (() => void)[] = [];
    let selectedIndex = -1;
    const model = {
      cols: 5,
      rows: 2,
      setSearchQuery: vi.fn(() => pendingStatus),
      stepSearch: vi
        .fn<() => GhosttySearchStatus>()
        .mockReturnValueOnce(pendingStatus)
        .mockImplementation(() => ({ ...completeStatus, selectedIndex })),
      selectSearchMatch: vi.fn(() => {
        selectedIndex = 1;
        return { ...completeStatus, selectedIndex };
      }),
      searchViewportMatches: vi.fn(() => []),
      clearSearch: vi.fn(),
    } as unknown as GhosttyTerminalModelApi;
    const controller = new GhosttySearchController(model, vi.fn(), {
      request: (callback) => callbacks.push(callback),
      cancel: () => {},
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribeMatchCount(listener);
    expect(controller.matchCount()).toBeNull();

    controller.findNext("agent");
    expect(controller.matchCount()).toEqual({
      current: 0,
      total: 1,
      capped: false,
      pending: true,
    });
    callbacks.shift()?.();
    expect(controller.matchCount()).toEqual({
      current: 2,
      total: 2,
      capped: false,
      pending: false,
    });
    expect(listener).toHaveBeenCalledTimes(2);

    // Streaming output steps the search again: an unchanged count is not news.
    const before = controller.matchCount();
    controller.refresh();
    expect(controller.matchCount()).toBe(before);
    expect(listener).toHaveBeenCalledTimes(2);

    controller.clearDecorations();
    expect(controller.matchCount()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    controller.findNext("again");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("counts from the selected index and marks the regex engine's cap", () => {
    expect(searchMatchCount(completeStatus, false)).toEqual({
      current: 0,
      total: 2,
      capped: false,
      pending: false,
    });
    expect(
      searchMatchCount({ ...completeStatus, selectedIndex: 0 }, false).current,
    ).toBe(1);
    const full = { ...completeStatus, totalMatches: MAX_REGEX_MATCHES };
    expect(searchMatchCount(full, true).capped).toBe(true);
    expect(searchMatchCount(full, false).capped).toBe(false);
  });

  it("cancels pending work and clears Ghostty search state", () => {
    const cancel = vi.fn();
    const model = {
      cols: 1,
      rows: 1,
      setSearchQuery: vi.fn(() => pendingStatus),
      stepSearch: vi.fn(() => pendingStatus),
      searchViewportMatches: vi.fn(() => []),
      clearSearch: vi.fn(),
    } as unknown as GhosttyTerminalModelApi;
    const controller = new GhosttySearchController(model, vi.fn(), {
      request: () => 42,
      cancel,
    });

    controller.findPrevious("x");
    controller.clearDecorations();

    expect(cancel).toHaveBeenCalledWith(42);
    expect(model.clearSearch).toHaveBeenCalledOnce();
  });
});
