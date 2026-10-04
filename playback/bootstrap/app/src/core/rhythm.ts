// Viewing rhythm — every `watch` ms of viewing forces a `rest` ms break
// (default 30min / 10min per the wish); playback is blocked while a
// break is in effect. In-memory for the mockup — a reload clears an
// in-progress break (residual risk, noted in the return).

import { systemClock, type Clock } from "./clock";

export type RhythmConfig = { watchMs: number; restMs: number };

export const DEFAULT_RHYTHM: RhythmConfig = {
  watchMs: 30 * 60_000,
  restMs: 10 * 60_000,
};

export class ViewingRhythm {
  private watchMs = 0;
  private breakUntil: number | null = null;

  constructor(
    private readonly cfg: RhythmConfig = DEFAULT_RHYTHM,
    private readonly now: Clock = systemClock,
  ) {}

  // Called while the surface is playing. Accrual during a break is
  // ignored — a break cannot extend itself.
  accrue(ms: number): void {
    if (this.inBreak()) return;
    this.watchMs += ms;
    if (this.watchMs >= this.cfg.watchMs) {
      this.breakUntil = this.now() + this.cfg.restMs;
      this.watchMs = 0;
    }
  }

  inBreak(): boolean {
    if (this.breakUntil === null) return false;
    if (this.now() >= this.breakUntil) {
      this.breakUntil = null;
      return false;
    }
    return true;
  }

  breakRemainingMs(): number {
    return this.inBreak() && this.breakUntil !== null
      ? this.breakUntil - this.now()
      : 0;
  }

  canPlay(): boolean {
    return !this.inBreak();
  }

  nextBreakInMs(): number {
    return this.inBreak() ? 0 : this.cfg.watchMs - this.watchMs;
  }
}
