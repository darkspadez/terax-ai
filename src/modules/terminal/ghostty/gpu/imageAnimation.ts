/** Shortest wake-up, so a zero gap cannot turn into a frame loop. */
export const MIN_IMAGE_ANIMATION_DELAY_MS = 8;

export type ImageAnimationModel = {
  advanceImageAnimations?(nowMs: number): number | null;
};

export type ImageAnimationTimers = {
  set(callback: () => void, delayMs: number): number;
  clear(handle: number): void;
};

const browserTimers: ImageAnimationTimers = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle),
};

/**
 * Drives one surface's Kitty animations the way Ghostty's renderer does: the model is ticked
 * right before a frame reads it, so the frame shows the animation frame due now, and one wake-up
 * is armed for the next frame change. Only a surface that shows images ticks, and no wake-up is
 * armed while it cannot be seen (`suspend`); the first frame after that ticks again.
 */
export class ImageAnimationClock {
  private shown = false;
  /** When the next frame change is due; null when unknown (tick on the next frame). */
  private deadline: number | null = null;
  private timer: number | null = null;

  constructor(
    private readonly wake: () => void,
    private readonly timers: ImageAnimationTimers = browserTimers,
  ) {}

  /** Before the frame consumes the model's state. `active`: the surface can be seen. */
  beforeFrame(model: ImageAnimationModel, now: number, active: boolean): void {
    if (!this.shown || !model.advanceImageAnimations) return;
    if (this.deadline === null || now >= this.deadline) {
      this.clearTimer();
      this.deadline = null;
      const delay = model.advanceImageAnimations(now);
      if (delay === null || !Number.isFinite(delay)) return;
      this.deadline = now + Math.max(MIN_IMAGE_ANIMATION_DELAY_MS, delay);
    }
    if (!active) this.clearTimer();
    else if (this.timer === null) this.arm(this.deadline - now);
  }

  /**
   * After the frame read the placements. Images that just appeared ask for one more frame,
   * whose tick starts their animations' clock.
   */
  afterFrame(shown: boolean): void {
    const appeared = shown && !this.shown;
    this.shown = shown;
    if (!shown) this.suspend();
    else if (appeared) this.wake();
  }

  get armed(): boolean {
    return this.timer !== null;
  }

  /** Hidden or paused: no wake-ups until the next frame. */
  suspend(): void {
    this.clearTimer();
    this.deadline = null;
  }

  /** The surface's images are gone with its resources. */
  reset(): void {
    this.suspend();
    this.shown = false;
  }

  private arm(delay: number): void {
    this.timer = this.timers.set(() => {
      this.timer = null;
      // Due now, whatever the two clocks say: the next frame ticks.
      this.deadline = null;
      this.wake();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
