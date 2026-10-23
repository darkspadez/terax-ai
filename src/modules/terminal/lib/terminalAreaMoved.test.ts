import { describe, expect, it, vi } from "vitest";
import {
  notifyTerminalAreaMoved,
  subscribeTerminalAreaMoved,
} from "./terminalAreaMoved";

describe("terminalAreaMoved", () => {
  it("tells every subscriber until it unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeTerminalAreaMoved(first);
    const stopSecond = subscribeTerminalAreaMoved(second);
    notifyTerminalAreaMoved();
    stopFirst();
    notifyTerminalAreaMoved();
    stopSecond();
    notifyTerminalAreaMoved();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("lets a subscriber leave while being told", () => {
    const later = vi.fn();
    const stop = subscribeTerminalAreaMoved(() => stop());
    const stopLater = subscribeTerminalAreaMoved(later);
    notifyTerminalAreaMoved();
    notifyTerminalAreaMoved();
    stopLater();
    expect(later).toHaveBeenCalledTimes(2);
  });
});
