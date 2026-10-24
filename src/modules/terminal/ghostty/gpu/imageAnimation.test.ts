import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImageAnimationClock,
  MIN_IMAGE_ANIMATION_DELAY_MS,
} from "@/modules/terminal/ghostty/gpu/imageAnimation";

afterEach(() => vi.useRealTimers());

function harness(delays: Array<number | null> = []) {
  vi.useFakeTimers();
  const wake = vi.fn();
  const clock = new ImageAnimationClock(wake, {
    set: (callback, delay) => setTimeout(callback, delay) as unknown as number,
    clear: (handle) => clearTimeout(handle),
  });
  const model = {
    advanceImageAnimations: vi.fn((_now: number) => delays.shift() ?? null),
  };
  return { clock, model, wake };
}

describe("image animation clock", () => {
  it("never ticks a surface that shows no images", () => {
    const h = harness([100]);
    h.clock.beforeFrame(h.model, 0, true);
    h.clock.afterFrame(false);
    h.clock.beforeFrame(h.model, 16, true);
    expect(h.model.advanceImageAnimations).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asks for one more frame when images appear, which starts their clock", () => {
    const h = harness([40]);
    h.clock.afterFrame(true);
    expect(h.wake).toHaveBeenCalledOnce();
    // Still shown: no further request.
    h.clock.afterFrame(true);
    expect(h.wake).toHaveBeenCalledOnce();
    h.clock.beforeFrame(h.model, 1_000, true);
    expect(h.model.advanceImageAnimations).toHaveBeenCalledExactlyOnceWith(
      1_000,
    );
    expect(h.clock.armed).toBe(true);
  });

  it("ticks before the frame that is due and wakes the surface after the returned delay", () => {
    const h = harness([40, 70]);
    h.clock.afterFrame(true);
    h.wake.mockClear();
    h.clock.beforeFrame(h.model, 0, true);
    // A frame before the deadline (other output) does not advance the animation.
    h.clock.beforeFrame(h.model, 20, true);
    expect(h.model.advanceImageAnimations).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(39);
    expect(h.wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.wake).toHaveBeenCalledOnce();
    // The woken frame ticks even if the page clock lags the timer.
    h.clock.beforeFrame(h.model, 39.5, true);
    expect(h.model.advanceImageAnimations).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(70);
    expect(h.wake).toHaveBeenCalledTimes(2);
  });

  it("ticks every frame of a still image, so an animation started later is noticed", () => {
    const h = harness([null, null, 30]);
    h.clock.afterFrame(true);
    h.clock.beforeFrame(h.model, 0, true);
    h.clock.beforeFrame(h.model, 10, true);
    expect(vi.getTimerCount()).toBe(0);
    h.clock.beforeFrame(h.model, 20, true);
    expect(h.model.advanceImageAnimations).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("never wakes faster than the minimum delay", () => {
    const h = harness([0]);
    h.clock.afterFrame(true);
    h.wake.mockClear();
    h.clock.beforeFrame(h.model, 0, true);
    vi.advanceTimersByTime(MIN_IMAGE_ANIMATION_DELAY_MS - 1);
    expect(h.wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.wake).toHaveBeenCalledOnce();
  });

  it("arms nothing while the surface cannot be seen and ticks on the first frame back", () => {
    const h = harness([40, 40, 40]);
    h.clock.afterFrame(true);
    h.wake.mockClear();
    h.clock.beforeFrame(h.model, 0, true);
    h.clock.suspend();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(h.wake).not.toHaveBeenCalled();
    // A frame that is not visible advances but arms nothing ...
    h.clock.beforeFrame(h.model, 1_000, false);
    expect(h.model.advanceImageAnimations).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    // ... and the next visible one waits for the rest of that deadline.
    h.clock.beforeFrame(h.model, 1_016, true);
    expect(h.model.advanceImageAnimations).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(23);
    expect(h.wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.wake).toHaveBeenCalledOnce();
  });

  it("stops when the images go and starts over after a reset", () => {
    const h = harness([40, 40]);
    h.clock.afterFrame(true);
    h.clock.beforeFrame(h.model, 0, true);
    h.clock.afterFrame(false);
    expect(vi.getTimerCount()).toBe(0);
    h.clock.beforeFrame(h.model, 50, true);
    expect(h.model.advanceImageAnimations).toHaveBeenCalledOnce();
    h.wake.mockClear();
    h.clock.afterFrame(true);
    h.clock.reset();
    expect(vi.getTimerCount()).toBe(0);
    h.clock.afterFrame(true);
    expect(h.wake).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a model without animation support", () => {
    const h = harness();
    h.clock.afterFrame(true);
    h.clock.beforeFrame({}, 0, true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
